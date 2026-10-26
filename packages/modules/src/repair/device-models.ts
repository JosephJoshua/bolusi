// Phone models to suggest at intake: the crawled catalog (with photos) plus the models this store
// has already taken in, so a phone missing from the catalog is suggested after its first intake.
//
// Found with the shared fuzzy search (core search/), so "samsng a55", "redmi note13" or a maker
// code like "A556" all find their model. The catalog is ~13k rows and changes only when the device
// downloads a new page of it; learned models change with every intake. Both are kept in one
// in-memory index per store (live-index.ts): a catalog download marks the whole index stale (it
// reports the `phone_models` table), an intake reloads just its own model.
import { z } from 'zod';

import {
  normalizeText,
  searchIndexFor,
  type QueryContext,
  type QueryPage,
  type ReadonlyProjectionDb,
  type SearchDocument,
  type SearchScope,
  type SearchSource,
} from '@bolusi/core';

import { REPAIR_PERMISSION, REPAIR_TABLE, REPAIR_TICKET_ENTITY } from './constants.js';
import type { RepairDatabase } from './schema.js';

export const PHONE_MODELS_TABLE = 'phone_models';

type Db = ReadonlyProjectionDb<RepairDatabase>;

export type DeviceModelKind = 'phone' | 'tablet' | 'watch';

export interface DeviceModelPhoto {
  readonly modelId: number;
  readonly sha256: string;
}

export interface DeviceModelRow {
  /** Stable within this device: `c:<catalog id>` or `l:<brand and model as typed>`. */
  readonly key: string;
  readonly brand: string;
  /** What goes in the ticket's model field: `Galaxy A55`. */
  readonly model: string;
  /** Null for a model learned from an intake. */
  readonly kind: DeviceModelKind | null;
  readonly announcedYear: number | null;
  readonly photo: DeviceModelPhoto | null;
  /** True when it came from this store's own intakes, not the catalog. */
  readonly learned: boolean;
}

/** Letters and digits only, lower case: how two spellings of one model are told apart. */
function compact(...parts: string[]): string {
  return normalizeText(parts.join(' ')).replace(/ /g, '');
}

/** Whether two brand-and-model spellings are the same model ("samsung" "a-55" = "Samsung" "A55"). */
export function sameDeviceModel(
  a: { readonly brand: string; readonly model: string },
  b: { readonly brand: string; readonly model: string },
): boolean {
  const key = compact(a.brand, a.model);
  return key !== '' && key === compact(b.brand, b.model);
}

/**
 * The ways staff may write a catalog model: with or without the brand, and without the series
 * word GSMArena puts first ("Samsung A55" for "Samsung Galaxy A55"). An intake whose brand and
 * model compact to one of these is that catalog model, so it is not suggested twice. This is an
 * exact comparison on purpose: it decides identity, not what a search finds.
 */
export function catalogKeys(brand: string, name: string): string[] {
  const tail = name.trim().split(/\s+/).slice(1).join(' ');
  const keys = [compact(brand, name), compact(name)];
  if (tail !== '') keys.push(compact(brand, tail));
  return keys;
}

const CATALOG_PREFIX = 'c:';
const LEARNED_PREFIX = 'l:';

function learnedKey(brand: string, model: string): string {
  return LEARNED_PREFIX + JSON.stringify([brand.trim(), model.trim()]);
}

function parseLearnedKey(key: string): [string, string] | null {
  try {
    const value: unknown = JSON.parse(key.slice(LEARNED_PREFIX.length));
    return Array.isArray(value) && value.length === 2 ? (value as [string, string]) : null;
  } catch {
    return null;
  }
}

function catalogRows(db: Db) {
  return db
    .selectFrom('phoneModels')
    .select(['id', 'brand', 'name', 'kind', 'announcedYear', 'modelCodes', 'photoSha256']);
}

type CatalogRow = Awaited<ReturnType<ReturnType<typeof catalogRows>['execute']>>[number];

function catalogDocument(row: CatalogRow): SearchDocument {
  return {
    id: CATALOG_PREFIX + String(row.id),
    text: [row.brand, row.name],
    codes: row.modelCodes === '' ? [] : row.modelCodes.split(','),
    // Newer models first among equal matches: those are the ones that come in.
    rank: row.announcedYear ?? 0,
  };
}

function intakeModels(db: Db, scope: SearchScope) {
  return db
    .selectFrom('repairTickets')
    .select(['deviceBrand', 'deviceModel', 'createdAt'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId);
}

type IntakeModel = { deviceBrand: string; deviceModel: string; createdAt: number };

/** One document per model the store took in that the catalog does not have, latest spelling. */
function learnedDocuments(
  intakes: readonly IntakeModel[],
  covered: ReadonlySet<string>,
): SearchDocument[] {
  const latest = new Map<string, IntakeModel>();
  for (const intake of intakes) {
    const key = compact(intake.deviceBrand, intake.deviceModel);
    if (key === '' || covered.has(key)) continue;
    const seen = latest.get(key);
    if (seen === undefined || Number(intake.createdAt) > Number(seen.createdAt)) {
      latest.set(key, intake);
    }
  }
  return [...latest.values()].map((intake) => ({
    id: learnedKey(intake.deviceBrand, intake.deviceModel),
    text: [intake.deviceBrand, intake.deviceModel],
    // Rank by year like the catalog does; a model the store saw lately counts as this year's.
    rank: new Date(Number(intake.createdAt)).getUTCFullYear(),
  }));
}

async function coveredKeys(db: Db, brands?: readonly string[]): Promise<Set<string>> {
  let query = db.selectFrom('phoneModels').select(['brand', 'name']);
  if (brands !== undefined) {
    if (brands.length === 0) return new Set();
    query = query.where((eb) =>
      eb(
        eb.fn('lower', ['brand']),
        'in',
        brands.map((brand) => brand.trim().toLowerCase()),
      ),
    );
  }
  const keys = new Set<string>();
  for (const row of await query.execute()) {
    for (const key of catalogKeys(row.brand, row.name)) keys.add(key);
  }
  return keys;
}

export const deviceModelSearchSource: SearchSource<RepairDatabase> = {
  name: 'repair.deviceModels',
  tables: [PHONE_MODELS_TABLE, REPAIR_TABLE.tickets],
  entityTypes: [REPAIR_TICKET_ENTITY],
  async loadAll(db, scope) {
    const catalog = await catalogRows(db).execute();
    const covered = new Set<string>();
    for (const row of catalog) for (const key of catalogKeys(row.brand, row.name)) covered.add(key);
    return [
      ...catalog.map(catalogDocument),
      ...learnedDocuments(await intakeModels(db, scope).execute(), covered),
    ];
  },
  async loadChanged(db, scope, changed) {
    const ticketIds = changed.get(REPAIR_TICKET_ENTITY) ?? [];
    if (ticketIds.length === 0) return { documents: [], checked: [] };
    const intakes: IntakeModel[] = [];
    for (let i = 0; i < ticketIds.length; i += 500) {
      intakes.push(
        ...(await intakeModels(db, scope)
          .where('id', 'in', ticketIds.slice(i, i + 500))
          .execute()),
      );
    }
    // A learned model is never removed by a later change: once seen, it stays a suggestion.
    const covered = await coveredKeys(db, [...new Set(intakes.map((i) => i.deviceBrand))]);
    return { documents: learnedDocuments(intakes, covered), checked: [] };
  },
};

export const searchDeviceModelsInput = z
  .object({
    text: z.string().max(200),
    limit: z.number().int().min(1).max(20).default(6),
  })
  .strict();

export type SearchDeviceModelsInput = z.infer<typeof searchDeviceModelsInput>;

function toRow(row: CatalogRow): DeviceModelRow {
  return {
    key: CATALOG_PREFIX + String(row.id),
    brand: row.brand,
    model: row.name,
    kind: row.kind as DeviceModelKind,
    announcedYear: row.announcedYear,
    photo: row.photoSha256 === null ? null : { modelId: row.id, sha256: row.photoSha256 },
    learned: false,
  };
}

export async function searchDeviceModelsHandler(
  input: SearchDeviceModelsInput,
  qctx: QueryContext<RepairDatabase>,
): Promise<QueryPage<DeviceModelRow>> {
  const index = await searchIndexFor(qctx, deviceModelSearchSource);
  // A few extra hits, since two spellings of one learned model may both be indexed.
  const keys = index.search(input.text, input.limit + 4).map((hit) => hit.id);
  const catalogIds = keys
    .filter((key) => key.startsWith(CATALOG_PREFIX))
    .map((key) => Number(key.slice(CATALOG_PREFIX.length)));
  const catalog = new Map(
    catalogIds.length === 0
      ? []
      : (await catalogRows(qctx.db).where('id', 'in', catalogIds).execute()).map((row) => [
          CATALOG_PREFIX + String(row.id),
          toRow(row),
        ]),
  );
  const rows: DeviceModelRow[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    let row: DeviceModelRow | undefined;
    if (key.startsWith(LEARNED_PREFIX)) {
      const parsed = parseLearnedKey(key);
      if (parsed !== null) {
        row = {
          key,
          brand: parsed[0],
          model: parsed[1],
          kind: null,
          announcedYear: null,
          photo: null,
          learned: true,
        };
      }
    } else {
      row = catalog.get(key);
    }
    if (row === undefined) continue;
    const identity = compact(row.brand, row.model);
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push(row);
    if (rows.length === input.limit) break;
  }
  return { rows, nextCursor: null };
}

export const searchDeviceModelsQuery = {
  name: 'searchDeviceModels',
  permission: REPAIR_PERMISSION.intake,
  input: searchDeviceModelsInput,
  handler: searchDeviceModelsHandler,
} as const;

export const findDeviceModelInput = z
  .object({ brand: z.string().max(100), model: z.string().max(200) })
  .strict();

export type FindDeviceModelInput = z.infer<typeof findDeviceModelInput>;

/**
 * The catalog model a ticket's brand and model name, for showing its photo on the ticket. An
 * exact match on the compacted spelling (see `catalogKeys`): a ticket shows a photo only when it
 * is surely that model, never a near miss.
 */
export async function findDeviceModelHandler(
  input: FindDeviceModelInput,
  qctx: QueryContext<RepairDatabase>,
): Promise<QueryPage<DeviceModelRow>> {
  const wanted = compact(input.brand, input.model);
  if (wanted === '') return { rows: [], nextCursor: null };
  const candidates = await catalogRows(qctx.db)
    .where((eb) => eb(eb.fn('lower', ['brand']), '=', input.brand.trim().toLowerCase()))
    .orderBy('announcedYear', 'desc')
    .execute();
  const match = candidates.find((row) => catalogKeys(row.brand, row.name).includes(wanted));
  return { rows: match === undefined ? [] : [toRow(match)], nextCursor: null };
}

export const findDeviceModelQuery = {
  name: 'findDeviceModel',
  permission: REPAIR_PERMISSION.read,
  input: findDeviceModelInput,
  handler: findDeviceModelHandler,
} as const;
