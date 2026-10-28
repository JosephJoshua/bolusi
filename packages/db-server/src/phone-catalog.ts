// The phone catalog's reads and writes (migration 0016). Global reference data, so these run on
// the plain pool, never through forTenant; the catalog tables hold no tenant rows to leak.
//
// Reads serve devices (apps/server routes/catalog.ts) and work as `bolusi_app`, which has SELECT
// only. Writes serve the crawler (apps/server catalog/crawl.ts), which runs as the table owner;
// under `bolusi_app` every write is refused by Postgres. Fixed functions, not a handle: nothing
// here can reach a tenant table.
import { sql, type Kysely } from 'kysely';

import type { PhoneSpecs } from '@bolusi/schemas';

import { getDb } from './db.js';
import type { DB } from './generated/db.js';

export type PhoneModelKind = 'phone' | 'tablet' | 'watch';

/** A catalog row as devices keep it. */
export interface PhoneModelRecord {
  readonly id: number;
  readonly brand: string;
  readonly name: string;
  readonly kind: PhoneModelKind;
  readonly announcedYear: number | null;
  /** Comma-separated maker codes, '' when unknown. */
  readonly modelCodes: string;
  /** Null until a photo is stored. */
  readonly photoSha256: string | null;
  readonly specs: PhoneSpecs;
  readonly revision: number;
}

export interface PhoneModelPhoto {
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** The catalog rows changed after `after`, oldest change first. */
export async function readPhoneModelsFrom(
  db: Kysely<DB>,
  after: number,
  limit: number,
): Promise<PhoneModelRecord[]> {
  const rows = await db
    .selectFrom('phoneModels')
    .select([
      'id',
      'brand',
      'name',
      'kind',
      'announcedYear',
      'modelCodes',
      'photoSha256',
      'specs',
      'revision',
    ])
    .where('revision', '>', String(after))
    .orderBy('revision')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    ...row,
    kind: row.kind as PhoneModelKind,
    // Written only by saveDetails below, from parseSpecs' output.
    specs: row.specs as PhoneSpecs,
    revision: Number(row.revision),
  }));
}

export async function readPhoneModelPhotoFrom(
  db: Kysely<DB>,
  modelId: number,
): Promise<PhoneModelPhoto | null> {
  const row = await db
    .selectFrom('phoneModelPhotos')
    .select(['sha256', 'mime', 'bytes'])
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : { sha256: row.sha256, mime: row.mime, bytes: new Uint8Array(row.bytes) };
}

/** A model as a brand's listing page shows it. */
export interface ListedPhoneModel {
  readonly id: number;
  readonly brand: string;
  readonly name: string;
  readonly kind: PhoneModelKind;
  readonly announcedYear: number | null;
  readonly pagePath: string;
  readonly photoUrl: string | null;
}

/** What the device's own page adds. */
export interface PhoneModelDetails {
  readonly modelCodes: readonly string[];
  readonly announcedYear: number | null;
  readonly specs: PhoneSpecs;
}

export interface CatalogBrand {
  readonly path: string;
  readonly name: string;
  readonly listedAt: number | null;
}

export interface PendingModel {
  readonly id: number;
  readonly pagePath: string;
  readonly photoUrl: string | null;
}

/** What the crawler needs from the catalog tables. */
export interface PhoneCatalogWriter {
  saveBrands(brands: readonly { path: string; name: string }[]): Promise<void>;
  brands(): Promise<CatalogBrand[]>;
  markBrandListed(path: string, at: number): Promise<void>;
  /** Insert new models and update changed ones; returns how many were new. */
  saveListedModels(models: readonly ListedPhoneModel[], at: number): Promise<number>;
  /** Models with a photo address not yet fetched, newest first. */
  modelsNeedingPhoto(limit: number): Promise<PendingModel[]>;
  /** Store the photo, or record that there is none to get (`null`). */
  savePhoto(modelId: number, photo: PhoneModelPhoto | null, at: number): Promise<void>;
  /** Remove a wrong photo; devices get a new revision when a stored one goes. */
  removePhoto(modelId: number, at: number): Promise<void>;
  /** Models whose own page was never fetched, newest first. */
  modelsNeedingDetails(limit: number): Promise<PendingModel[]>;
  /** Store the page's details, or record that the page is gone (`null`). */
  saveDetails(modelId: number, details: PhoneModelDetails | null, at: number): Promise<void>;
}

/** jsonb does not keep key order, so specs are compared key by key. */
function sameSpecs(a: PhoneSpecs, b: PhoneSpecs): boolean {
  const keys = Object.keys(a) as (keyof PhoneSpecs)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const nextRevision = sql<string>`nextval('phone_models_revision_seq')`;

/** Order pending work so recent phones, the ones a shop sees, are done first. */
function pending(db: Kysely<DB>) {
  return db
    .selectFrom('phoneModels')
    .select(['id', 'pagePath', 'photoUrl'])
    .orderBy(sql`announced_year DESC NULLS LAST`)
    .orderBy('id', 'desc');
}

export function createPhoneCatalogWriterOn(db: Kysely<DB>): PhoneCatalogWriter {
  return {
    async saveBrands(brands) {
      if (brands.length === 0) return;
      await db
        .insertInto('phoneCatalogBrands')
        .values(brands.map(({ path, name }) => ({ path, name })))
        .onConflict((oc) =>
          oc.column('path').doUpdateSet({ name: (eb) => eb.ref('excluded.name') }),
        )
        .execute();
    },

    async brands() {
      const rows = await db
        .selectFrom('phoneCatalogBrands')
        .select(['path', 'name', 'listedAt'])
        .orderBy('name')
        .execute();
      return rows.map((row) => ({
        ...row,
        listedAt: row.listedAt === null ? null : Number(row.listedAt),
      }));
    },

    async markBrandListed(path, at) {
      await db
        .updateTable('phoneCatalogBrands')
        .set({ listedAt: at })
        .where('path', '=', path)
        .execute();
    },

    async saveListedModels(models, at) {
      if (models.length === 0) return 0;
      return db.transaction().execute(async (trx) => {
        const existing = new Map(
          (
            await trx
              .selectFrom('phoneModels')
              .select([
                'id',
                'brand',
                'name',
                'kind',
                'announcedYear',
                'pagePath',
                'photoUrl',
                'detailsAt',
              ])
              .where(
                'id',
                'in',
                models.map((m) => m.id),
              )
              .execute()
          ).map((row) => [row.id, row]),
        );
        let added = 0;
        for (const model of models) {
          const old = existing.get(model.id);
          if (old === undefined) {
            await trx
              .insertInto('phoneModels')
              .values({ ...model, revision: nextRevision, createdAt: at, updatedAt: at })
              .execute();
            added += 1;
            continue;
          }
          // Once the device page was read its year is the precise one; the listing's is a guess.
          const announcedYear = old.detailsAt === null ? model.announcedYear : old.announcedYear;
          const synced =
            old.brand !== model.brand ||
            old.name !== model.name ||
            old.kind !== model.kind ||
            old.announcedYear !== announcedYear;
          const photoMoved = old.photoUrl !== model.photoUrl;
          if (!synced && !photoMoved && old.pagePath === model.pagePath) continue;
          await trx
            .updateTable('phoneModels')
            .set({
              brand: model.brand,
              name: model.name,
              kind: model.kind,
              announcedYear,
              pagePath: model.pagePath,
              photoUrl: model.photoUrl,
              // A new photo address is fetched again; the old photo stays until it is.
              ...(photoMoved ? { photoAt: null } : {}),
              ...(synced ? { revision: nextRevision } : {}),
              updatedAt: at,
            })
            .where('id', '=', model.id)
            .execute();
        }
        return added;
      });
    },

    async modelsNeedingPhoto(limit) {
      return pending(db)
        .where('photoUrl', 'is not', null)
        .where('photoAt', 'is', null)
        .limit(limit)
        .execute();
    },

    async savePhoto(modelId, photo, at) {
      await db.transaction().execute(async (trx) => {
        if (photo === null) {
          await trx
            .updateTable('phoneModels')
            .set({ photoAt: at, updatedAt: at })
            .where('id', '=', modelId)
            .execute();
          return;
        }
        await trx
          .insertInto('phoneModelPhotos')
          .values({ modelId, ...photo, bytes: Buffer.from(photo.bytes), fetchedAt: at })
          .onConflict((oc) =>
            oc.column('modelId').doUpdateSet({
              sha256: photo.sha256,
              mime: photo.mime,
              bytes: Buffer.from(photo.bytes),
              fetchedAt: at,
            }),
          )
          .execute();
        const old = await trx
          .selectFrom('phoneModels')
          .select('photoSha256')
          .where('id', '=', modelId)
          .executeTakeFirst();
        await trx
          .updateTable('phoneModels')
          .set({
            photoSha256: photo.sha256,
            photoAt: at,
            updatedAt: at,
            ...(old?.photoSha256 === photo.sha256 ? {} : { revision: nextRevision }),
          })
          .where('id', '=', modelId)
          .execute();
      });
    },

    async removePhoto(modelId, at) {
      await db.transaction().execute(async (trx) => {
        const old = await trx
          .selectFrom('phoneModels')
          .select('photoSha256')
          .where('id', '=', modelId)
          .forUpdate()
          .executeTakeFirst();
        if (old === undefined) return;
        await trx.deleteFrom('phoneModelPhotos').where('modelId', '=', modelId).execute();
        await trx
          .updateTable('phoneModels')
          .set({
            photoSha256: null,
            photoAt: at,
            updatedAt: at,
            ...(old.photoSha256 === null ? {} : { revision: nextRevision }),
          })
          .where('id', '=', modelId)
          .execute();
      });
    },

    async modelsNeedingDetails(limit) {
      return pending(db).where('detailsAt', 'is', null).limit(limit).execute();
    },

    async saveDetails(modelId, details, at) {
      if (details === null) {
        await db
          .updateTable('phoneModels')
          .set({ detailsAt: at, updatedAt: at })
          .where('id', '=', modelId)
          .execute();
        return;
      }
      const modelCodes = details.modelCodes.join(', ');
      await db.transaction().execute(async (trx) => {
        const old = await trx
          .selectFrom('phoneModels')
          .select(['modelCodes', 'announcedYear', 'specs'])
          .where('id', '=', modelId)
          .executeTakeFirst();
        if (old === undefined) return;
        const announcedYear = details.announcedYear ?? old.announcedYear;
        const specs = JSON.stringify(details.specs);
        const synced =
          old.modelCodes !== modelCodes ||
          old.announcedYear !== announcedYear ||
          !sameSpecs(old.specs as PhoneSpecs, details.specs);
        await trx
          .updateTable('phoneModels')
          .set({
            modelCodes,
            announcedYear,
            specs,
            detailsAt: at,
            updatedAt: at,
            ...(synced ? { revision: nextRevision } : {}),
          })
          .where('id', '=', modelId)
          .execute();
      });
    },
  };
}

// The exported entry points, on the package's pool (tests bind their own database).
export const readPhoneModels = (after: number, limit: number): Promise<PhoneModelRecord[]> =>
  readPhoneModelsFrom(getDb(), after, limit);

export const readPhoneModelPhoto = (modelId: number): Promise<PhoneModelPhoto | null> =>
  readPhoneModelPhotoFrom(getDb(), modelId);

export const createPhoneCatalogWriter = (): PhoneCatalogWriter =>
  createPhoneCatalogWriterOn(getDb());
