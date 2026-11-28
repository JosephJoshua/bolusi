// The repair price list as the screens read it: the business's rows with what this store charges,
// found by phone with the shared fuzzy search ("samsng a12" finds the A12's prices), or narrowed to
// one repair type. Every staff member who sees servisan reads it, so the counter can answer "berapa
// ganti LCD A12?" without opening an intake.
import { sql } from 'kysely';
import { z } from 'zod';

import {
  searchIndexFor,
  type ChangedEntities,
  type QueryContext,
  type QueryPage,
  type ReadonlyProjectionDb,
  type SearchDocument,
  type SearchScope,
  type SearchSource,
} from '@bolusi/core';

import { REPAIR_PERMISSION, REPAIR_PRICE_ENTITY, REPAIR_TABLE } from './constants.js';
import { catalogKeys } from './device-models.js';
import { MAX_PRICE_MODELS, zOptionId } from './operations.js';
import { readIntakeOptionSettings } from './queries.js';
import { zPartFit } from '../inventory/operations.js';
import type { RepairDatabase } from './schema.js';

type Qctx = QueryContext<RepairDatabase>;
type Db = ReadonlyProjectionDb<RepairDatabase>;

export interface PriceModel {
  readonly brand: string;
  readonly model: string;
}

export interface PriceRow {
  readonly id: string;
  readonly repairType: string;
  /** '' when the row names no quality. */
  readonly quality: string;
  readonly models: readonly PriceModel[];
  /** The business's price. */
  readonly listAmount: number;
  /** What this store charges instead; null when it charges the list's price. */
  readonly storeAmount: number | null;
  /** What this store charges: its own price, else the list's. */
  readonly amount: number;
  readonly updatedAt: number;
}

/** "Samsung Galaxy A12", or the model alone when it was typed without a brand. */
export function priceModelLabel(model: PriceModel): string {
  return `${model.brand} ${model.model}`.trim();
}

function parseModels(text: string): PriceModel[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as PriceModel[]) : [];
  } catch {
    return [];
  }
}

// ── search ─────────────────────────────────────────────────────────────────────────────────────

/** SQLite caps bound parameters; a big sync can change thousands of rows at once. */
const CHUNK = 500;

function searchRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('repairPrices')
    .select(['id', 'quality', 'modelsJson'])
    .where('tenantId', '=', scope.tenantId)
    .where('removed', '=', 0);
}

type SearchRow = Awaited<ReturnType<ReturnType<typeof searchRows>['execute']>>[number];

/** A row as the fuzzy search sees it: its phones, then its quality. */
export function priceDocument(row: {
  readonly id: string;
  readonly quality: string;
  readonly models: readonly PriceModel[];
}): SearchDocument {
  return {
    id: row.id,
    text: [...row.models.map(priceModelLabel), row.quality],
    codes: [],
    rank: 1,
  };
}

const documentOf = (row: SearchRow): SearchDocument =>
  priceDocument({ id: row.id, quality: row.quality, models: parseModels(row.modelsJson) });

export const priceSearchSource: SearchSource<RepairDatabase> = {
  name: 'repair.prices',
  tables: [REPAIR_TABLE.prices],
  entityTypes: [REPAIR_PRICE_ENTITY],
  async loadAll(db, scope) {
    return (await searchRows(db, scope).execute()).map(documentOf);
  },
  async loadChanged(db, scope, changed: ChangedEntities) {
    const ids = changed.get(REPAIR_PRICE_ENTITY) ?? [];
    const found: SearchDocument[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await searchRows(db, scope)
        .where('id', 'in', ids.slice(i, i + CHUNK))
        .execute();
      found.push(...rows.map(documentOf));
    }
    return { documents: found, checked: ids };
  },
};

// ── priceList ──────────────────────────────────────────────────────────────────────────────────

/** The PC's sheet holds the whole list at once; a phone pages through it. */
export const MAX_PRICE_PAGE = 5000;
const MAX_SEARCH_WINDOW = 5000;

export const priceListInput = z
  .object({
    /** Phones typed to find, fuzzily; '' lists every row. */
    text: z.string().max(200).default(''),
    /** Only this repair type's rows. */
    repairType: zOptionId.nullable().default(null),
    /** Leave out the repair types this store hides, as the counter quotes only what it offers. */
    storeOnly: z.boolean().default(false),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(MAX_PRICE_PAGE).default(50),
  })
  .strict();

function priceRows(qctx: Qctx) {
  return qctx.db
    .selectFrom('repairPrices as p')
    .leftJoin('repairStorePrices as s', (join) =>
      join.onRef('s.priceId', '=', 'p.id').on('s.storeId', '=', qctx.storeId ?? ''),
    )
    .select([
      'p.id',
      'p.repairType',
      'p.quality',
      'p.modelsJson',
      'p.amount',
      'p.updatedAt',
      's.amount as storeAmount',
    ])
    .where('p.tenantId', '=', qctx.tenantId)
    .where('p.removed', '=', 0);
}

type ListedRow = Awaited<ReturnType<ReturnType<typeof priceRows>['execute']>>[number];

function toPriceRow(row: ListedRow): PriceRow {
  const listAmount = Number(row.amount);
  const storeAmount = row.storeAmount === null ? null : Number(row.storeAmount);
  return {
    id: row.id,
    repairType: row.repairType,
    quality: row.quality,
    models: parseModels(row.modelsJson),
    listAmount,
    storeAmount,
    amount: storeAmount ?? listAmount,
    updatedAt: Number(row.updatedAt),
  };
}

/**
 * The list's rows with this store's prices: ranked by how well their phones match the text, or with
 * no text by repair type, then phone, then quality, so a type's rows read together.
 */
export async function priceListHandler(
  input: z.output<typeof priceListInput>,
  qctx: Qctx,
): Promise<QueryPage<PriceRow>> {
  let query = priceRows(qctx);
  if (input.repairType !== null) query = query.where('p.repairType', '=', input.repairType);
  if (input.storeOnly && qctx.storeId !== null) {
    const hidden = (await readIntakeOptionSettings(qctx.db, qctx.tenantId, qctx.storeId)).hidden
      .repairTypes;
    if (hidden.length > 0) query = query.where('p.repairType', 'not in', hidden);
  }

  if (input.text.trim() !== '') {
    // The filter drops hits the index ranked, so the window widens until it holds the page.
    const index = await searchIndexFor(qctx, priceSearchSource);
    const wanted = input.offset + input.limit + 1;
    let window = wanted;
    let ranked: PriceRow[] = [];
    for (;;) {
      const ids = index.search(input.text, window).map((hit) => hit.id);
      if (ids.length === 0) return { rows: [], nextCursor: null };
      const found = new Map<string, PriceRow>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = await query.where('p.id', 'in', ids.slice(i, i + CHUNK)).execute();
        for (const row of rows) found.set(row.id, toPriceRow(row));
      }
      ranked = ids.map((id) => found.get(id)).filter((row) => row !== undefined);
      if (ranked.length >= wanted || ids.length < window || window >= MAX_SEARCH_WINDOW) break;
      window = Math.min(window * 4, MAX_SEARCH_WINDOW);
    }
    const page = ranked.slice(input.offset, input.offset + input.limit);
    const more = ranked.length > input.offset + input.limit;
    return { rows: page, nextCursor: more ? String(input.offset + input.limit) : null };
  }

  // The business's repair types in the order its list has them, as the intake offers them.
  const { lists } = await readIntakeOptionSettings(qctx.db, qctx.tenantId, null);
  const typeOrder =
    lists.repairTypes.length === 0
      ? sql<number>`0`
      : sql<number>`CASE p.repair_type ${sql.join(
          lists.repairTypes.map((type, i) => sql`WHEN ${type.id} THEN ${i}`),
          sql` `,
        )} ELSE ${lists.repairTypes.length} END`;
  const rows = await query
    .orderBy(typeOrder)
    .orderBy('p.repairType')
    .orderBy(sql`lower(p.models_json)`)
    .orderBy('p.quality')
    .orderBy('p.id')
    .limit(input.limit + 1)
    .offset(input.offset)
    .execute();
  const more = rows.length > input.limit;
  return {
    rows: rows.slice(0, input.limit).map(toPriceRow),
    nextCursor: more ? String(input.offset + input.limit) : null,
  };
}

export const priceListQuery = {
  name: 'priceList',
  permission: REPAIR_PERMISSION.read,
  input: priceListInput,
  handler: priceListHandler,
} as const;

// ── priceQualities ─────────────────────────────────────────────────────────────────────────────

export const priceQualitiesInput = z.object({}).strict();

/** The qualities the list already uses, most used first, to offer when typing a new row's. */
export async function priceQualitiesHandler(
  _input: z.output<typeof priceQualitiesInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly quality: string; readonly rows: number }>> {
  const rows = await qctx.db
    .selectFrom('repairPrices')
    .select(['quality', (eb) => eb.fn.countAll<number>().as('rows')])
    .where('tenantId', '=', qctx.tenantId)
    .where('removed', '=', 0)
    .where('quality', '!=', '')
    .groupBy('quality')
    .orderBy('rows', 'desc')
    .orderBy('quality')
    .execute();
  return {
    rows: rows.map((row) => ({ quality: row.quality, rows: Number(row.rows) })),
    nextCursor: null,
  };
}

export const priceQualitiesQuery = {
  name: 'priceQualities',
  permission: REPAIR_PERMISSION.read,
  input: priceQualitiesInput,
  handler: priceQualitiesHandler,
} as const;

// ── pricesForModels ────────────────────────────────────────────────────────────────────────────

export const pricesForModelsInput = z
  .object({
    models: z.array(zPartFit).min(1).max(MAX_PRICE_MODELS),
    repairType: zOptionId.nullable().default(null),
  })
  .strict();

/**
 * The rows that price any of these phones, however each was written ("Samsung A12" is the
 * catalog's "Galaxy A12", `catalogKeys`): the prices a servisan's phone is quoted from, and the
 * rows a new one would repeat. An exact comparison on purpose: it decides which phone a price is
 * for, not what a search finds.
 */
export async function pricesForModelsHandler(
  input: z.output<typeof pricesForModelsInput>,
  qctx: Qctx,
): Promise<QueryPage<PriceRow>> {
  const keys = [
    ...new Set(input.models.flatMap((m) => catalogKeys(m.brand, m.model)).filter((k) => k !== '')),
  ];
  if (keys.length === 0) return { rows: [], nextCursor: null };
  let query = priceRows(qctx).where((eb) =>
    eb(
      'p.id',
      'in',
      eb
        .selectFrom('repairPriceModels')
        .select('priceId')
        .where('tenantId', '=', qctx.tenantId)
        .where('modelKey', 'in', keys),
    ),
  );
  if (input.repairType !== null) query = query.where('p.repairType', '=', input.repairType);
  const rows = await query.orderBy('p.repairType').orderBy('p.quality').orderBy('p.id').execute();
  return { rows: rows.map(toPriceRow), nextCursor: null };
}

export const pricesForModelsQuery = {
  name: 'pricesForModels',
  permission: REPAIR_PERMISSION.read,
  input: pricesForModelsInput,
  handler: pricesForModelsHandler,
} as const;
