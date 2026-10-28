// Load a phone catalog file into the catalog tables through the crawler's writer, so a load
// behaves like a crawl that already happened: new rows and changed fields get fresh revisions
// and reach devices by normal sync, unchanged rows stay as they are, and a second load of the
// same file changes nothing.
//
// The file is newline-delimited JSON, one brand or model per line. A model carries what the
// listing gives (name, type, page, photo address) and may add its page's details (codes, specs)
// and its photo (or say it has none). The committed seed has names and codes only; the full catalog with specs and
// photos is kept privately (docs/development.md says why).
import { createHash } from 'node:crypto';

import type { ListedPhoneModel, PhoneCatalogWriter, PhoneModelPhoto } from '@bolusi/db-server';
import { PHONE_MODEL_KINDS, zPhoneSpecs } from '@bolusi/schemas';
import { z } from 'zod';

import { isBrandPath, modelIdOfPath } from './gsmarena.js';

const zBrandLine = z.strictObject({
  type: z.literal('brand'),
  path: z.string().refine(isBrandPath, 'not a brand page'),
  name: z.string().min(1),
});

const zModelLine = z
  .strictObject({
    type: z.literal('model'),
    id: z.number().int().positive(),
    brand: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(PHONE_MODEL_KINDS),
    announcedYear: z.number().int().min(1990).max(2100).nullable(),
    pagePath: z.string(),
    // Usually GSMArena's; a few come from the maker. The crawler only ever fetches GSMArena's.
    photoUrl: z.url({ protocol: /^https$/ }).nullable(),
    /** Present when the model's page was read; the specs may still be empty. */
    details: z
      .strictObject({ modelCodes: z.array(z.string().min(1)), specs: zPhoneSpecs })
      .optional(),
    /** The stored photo, `null` for none (a wrong one is removed), absent to leave it as it is. */
    photo: z
      .strictObject({
        mime: z.enum(['image/jpeg', 'image/png']),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        base64: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .refine((m) => modelIdOfPath(m.pagePath) === m.id, "page path is not this model's page");

export const zCatalogFileLine = z.discriminatedUnion('type', [zBrandLine, zModelLine]);
export type CatalogFileLine = z.infer<typeof zCatalogFileLine>;
type ModelLine = z.infer<typeof zModelLine>;

export interface CatalogLoadSummary {
  readonly brands: number;
  readonly models: number;
  readonly newModels: number;
  readonly details: number;
  readonly photos: number;
}

const BATCH = 500;

/** Parse every line first, so a bad file is refused before anything is written. */
export function parseCatalogFile(text: string): CatalogFileLine[] {
  const lines: CatalogFileLine[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`line ${index + 1}: not JSON`);
    }
    const parsed = zCatalogFileLine.safeParse(json);
    if (!parsed.success) {
      throw new Error(`line ${index + 1}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const key = parsed.data.type === 'brand' ? `b:${parsed.data.path}` : `m:${parsed.data.id}`;
    if (seen.has(key)) throw new Error(`line ${index + 1}: repeated ${key}`);
    seen.add(key);
    lines.push(parsed.data);
  });
  return lines;
}

function photoOf(model: ModelLine): PhoneModelPhoto | null | undefined {
  if (model.photo == null) return model.photo;
  const bytes = Buffer.from(model.photo.base64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== model.photo.sha256) {
    throw new Error(`model ${model.id}: photo does not match its hash`);
  }
  return { mime: model.photo.mime, sha256: model.photo.sha256, bytes };
}

export async function loadCatalogFile(
  store: PhoneCatalogWriter,
  lines: readonly CatalogFileLine[],
  at: number,
  log: (line: string) => void = () => {},
): Promise<CatalogLoadSummary> {
  const brands = lines.filter((l) => l.type === 'brand');
  const models = lines.filter((l) => l.type === 'model');
  // Check every photo before the first write.
  const photos = new Map(models.map((m) => [m.id, photoOf(m)]));

  await store.saveBrands(brands.map(({ path, name }) => ({ path, name })));
  let newModels = 0;
  for (let i = 0; i < models.length; i += BATCH) {
    const listed: ListedPhoneModel[] = models
      .slice(i, i + BATCH)
      .map(({ id, brand, name, kind, announcedYear, pagePath, photoUrl }) => ({
        id,
        brand,
        name,
        kind,
        announcedYear,
        pagePath,
        photoUrl,
      }));
    newModels += await store.saveListedModels(listed, at);
    log(`models ${Math.min(i + BATCH, models.length)}/${models.length}`);
  }
  let details = 0;
  let stored = 0;
  for (const model of models) {
    if (model.details !== undefined) {
      await store.saveDetails(
        model.id,
        { ...model.details, announcedYear: model.announcedYear },
        at,
      );
      details += 1;
    }
    const photo = photos.get(model.id);
    if (photo === null) await store.removePhoto(model.id, at);
    if (photo != null) {
      await store.savePhoto(model.id, photo, at);
      stored += 1;
      if (stored % 2000 === 0) log(`photos ${stored}`);
    }
  }
  return { brands: brands.length, models: models.length, newModels, details, photos: stored };
}
