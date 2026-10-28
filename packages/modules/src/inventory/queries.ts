// The `inventory` queries. Parts are read across the tenant; stock is always this store's, the sum
// of its movements. Every read is scoped to the runtime-minted tenant and store.
import { sql } from 'kysely';
import { z } from 'zod';

import { searchIndexFor, type QueryContext, type QueryPage } from '@bolusi/core';

import { compactModel } from '../shared/model-key.js';
import { userNames } from '../shared/user-names.js';
import {
  INVENTORY_PERMISSION,
  PART_USE_KINDS,
  type MovementKind,
  type PartUseKind,
} from './constants.js';
import type { InventoryDatabase } from './schema.js';
import { partSearchSource } from './search.js';

type Qctx = QueryContext<InventoryDatabase>;

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

export interface PartRow {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly fits: string | null;
  readonly archived: boolean;
  /** What this store has: the sum of its movements. Below zero when more was taken than counted. */
  readonly onHand: number;
}

export interface MovementRow {
  readonly id: string;
  readonly partId: string;
  readonly kind: MovementKind;
  /** Signed change to stock. */
  readonly qty: number;
  readonly counted: number | null;
  readonly useKind: PartUseKind | null;
  readonly useId: string | null;
  readonly useLabel: string | null;
  readonly note: string | null;
  readonly userId: string;
  readonly userName: string | null;
  readonly at: number;
}

/** A phone model a part fits. */
export interface PartFitRow {
  readonly brand: string;
  readonly model: string;
}

export interface PartDetailRow extends PartRow {
  /** The phone models it fits, in the order picked. */
  readonly models: readonly PartFitRow[];
  /** Newest first, at most `MOVEMENTS_SHOWN`. */
  readonly movements: readonly MovementRow[];
}

/** One part a use has drawn on. */
export interface UsedPartRow {
  readonly partId: string;
  readonly name: string;
  readonly code: string | null;
  /** Taken minus put back: what is still on the use. */
  readonly out: number;
  /** What this store has now, for the take step's "Stok: 3". */
  readonly onHand: number;
}

export interface PartsForUseRow {
  readonly parts: readonly UsedPartRow[];
  /** Every take and put-back on the use, newest first. */
  readonly movements: readonly MovementRow[];
}

export const MOVEMENTS_SHOWN = 100;

/** The most fuzzy hits one search reads, however many the filter drops. */
const MAX_SEARCH_WINDOW = 2000;

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────

/** Each part's latest count in this store (latest by when it was counted), as `rn = 1`. */
function latestCounts(qctx: Qctx) {
  return qctx.db
    .selectFrom('inventoryMovements')
    .select([
      'partId',
      'counted',
      'at',
      'id',
      sql<number>`row_number() over (partition by part_id order by at desc, id desc)`.as('rn'),
    ])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('kind', '=', 'counted');
}

/**
 * This store's stock per part, as a subquery to join: the latest count, plus every take and
 * put-back made after it. Made after, by when it happened on the phone, not when it synced: a
 * take made before the count is already in what was counted, one made after still comes off, and
 * of two counts the later one stands. Without a count it is the takes and put-backs alone.
 */
function stockByPart(qctx: Qctx, partIds?: readonly string[]) {
  let query = qctx.db
    .selectFrom('inventoryMovements as m')
    .leftJoin(latestCounts(qctx).as('l'), (join) =>
      join.onRef('l.partId', '=', 'm.partId').on('l.rn', '=', 1),
    )
    .select([
      'm.partId',
      sql<number | string>`coalesce(max(l.counted), 0) + coalesce(sum(case
        when m.kind <> 'counted' and (l.at is null or m.at > l.at or (m.at = l.at and m.id > l.id))
        then m.qty else 0 end), 0)`.as('onHand'),
    ])
    .where('m.tenantId', '=', qctx.tenantId)
    .where('m.storeId', '=', qctx.storeId)
    .groupBy('m.partId');
  if (partIds !== undefined) query = query.where('m.partId', 'in', partIds);
  return query;
}

/** Parts with this store's stock; `partIds` narrows the stock sum to those parts. */
function partsWithStock(qctx: Qctx, partIds?: readonly string[]) {
  let query = qctx.db
    .selectFrom('inventoryParts as p')
    .leftJoin(stockByPart(qctx, partIds).as('s'), 's.partId', 'p.id')
    .select(['p.id', 'p.name', 'p.code', 'p.fits', 'p.archived', 's.onHand'])
    .where('p.tenantId', '=', qctx.tenantId);
  if (partIds !== undefined) query = query.where('p.id', 'in', partIds);
  return query;
}

type RawPart = Awaited<ReturnType<ReturnType<typeof partsWithStock>['execute']>>[number];

function toPart(row: RawPart): PartRow {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    fits: row.fits,
    archived: Number(row.archived) === 1,
    onHand: Number(row.onHand ?? 0),
  };
}

async function toMovements(
  qctx: Qctx,
  rows: readonly InventoryDatabase['inventoryMovements'][],
): Promise<MovementRow[]> {
  const names = await userNames(
    qctx.db,
    rows.map((row) => row.userId),
  );
  return rows.map((row) => ({
    id: row.id,
    partId: row.partId,
    kind: row.kind as MovementKind,
    qty: Number(row.qty),
    counted: row.counted === null ? null : Number(row.counted),
    useKind: row.useKind as PartUseKind | null,
    useId: row.useId,
    useLabel: row.useLabel,
    note: row.note,
    userId: row.userId,
    userName: names.get(row.userId) ?? null,
    at: Number(row.at),
  }));
}

function storeMovements(qctx: Qctx) {
  return qctx.db
    .selectFrom('inventoryMovements')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId);
}

// ── listParts ──────────────────────────────────────────────────────────────────────────────────

/** `active`: on the list; `belowZero`: more taken than the store had, for the owner to sort out. */
export const PART_FILTERS = ['active', 'belowZero', 'archived'] as const;
export type PartFilter = (typeof PART_FILTERS)[number];

export const listPartsInput = z
  .object({
    text: z.string().trim().max(200).default(''),
    filter: z.enum(PART_FILTERS).default('active'),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ListPartsInput = z.input<typeof listPartsInput>;

/**
 * Parts by name, or by fuzzy match when `text` is given (best match first). `nextCursor` is the
 * next offset while more remain.
 */
export async function listPartsHandler(
  input: z.output<typeof listPartsInput>,
  qctx: Qctx,
): Promise<QueryPage<PartRow>> {
  let query = partsWithStock(qctx);
  query =
    input.filter === 'archived'
      ? query.where('p.archived', '=', 1)
      : query.where('p.archived', '=', 0);
  // A part never moved here has no stock row, so it is never below zero.
  if (input.filter === 'belowZero') query = query.where('s.onHand', '<', 0);

  if (input.text !== '') {
    // Ranked by the shared fuzzy index; the filter then narrows the hits it ranked. Hits the filter
    // drops (archived, or in stock when only below zero is shown) leave gaps, so the window widens
    // until it holds the page and one more.
    const index = await searchIndexFor(qctx, partSearchSource);
    const wanted = input.offset + input.limit + 1;
    let window = wanted;
    let ranked: PartRow[] = [];
    for (;;) {
      const ids = index.search(input.text, window).map((hit) => hit.id);
      if (ids.length === 0) return { rows: [], nextCursor: null };
      const found = new Map(
        (await query.where('p.id', 'in', ids).execute()).map((row) => [row.id, toPart(row)]),
      );
      ranked = ids.map((id) => found.get(id)).filter((row) => row !== undefined);
      if (ranked.length >= wanted || ids.length < window || window >= MAX_SEARCH_WINDOW) break;
      window = Math.min(window * 4, MAX_SEARCH_WINDOW);
    }
    const page = ranked.slice(input.offset, input.offset + input.limit);
    const more = ranked.length > input.offset + input.limit;
    return { rows: page, nextCursor: more ? String(input.offset + input.limit) : null };
  }

  const rows = await query
    .orderBy(sql`lower(p.name)`)
    .orderBy('p.id')
    .limit(input.limit + 1)
    .offset(input.offset)
    .execute();
  const more = rows.length > input.limit;
  return {
    rows: rows.slice(0, input.limit).map(toPart),
    nextCursor: more ? String(input.offset + input.limit) : null,
  };
}

export const listPartsQuery = {
  name: 'listParts',
  permission: INVENTORY_PERMISSION.read,
  input: listPartsInput,
  handler: listPartsHandler,
} as const;

// ── countBelowZero ─────────────────────────────────────────────────────────────────────────────

export const countBelowZeroInput = z.object({}).strict();

/** How many parts on the list this store has below zero: the owner's "needs a look" badge. */
export async function countBelowZeroHandler(
  _input: z.output<typeof countBelowZeroInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly count: number }>> {
  const row = await qctx.db
    .selectFrom(stockByPart(qctx).as('s'))
    .innerJoin('inventoryParts as p', 'p.id', 's.partId')
    .select((eb) => eb.fn.countAll<number | string>().as('count'))
    .where('p.archived', '=', 0)
    .where('s.onHand', '<', 0)
    .executeTakeFirst();
  return { rows: [{ count: Number(row?.count ?? 0) }], nextCursor: null };
}

export const countBelowZeroQuery = {
  name: 'countBelowZero',
  permission: INVENTORY_PERMISSION.read,
  input: countBelowZeroInput,
  handler: countBelowZeroHandler,
} as const;

// ── getPart ────────────────────────────────────────────────────────────────────────────────────

export const getPartInput = z.object({ partId: z.string().min(1) }).strict();
export type GetPartInput = z.input<typeof getPartInput>;

export async function getPartHandler(
  input: z.output<typeof getPartInput>,
  qctx: Qctx,
): Promise<QueryPage<PartDetailRow>> {
  const row = await partsWithStock(qctx, [input.partId]).executeTakeFirst();
  if (row === undefined) return { rows: [], nextCursor: null };
  const models = await qctx.db
    .selectFrom('inventoryPartFits')
    .select(['brand', 'model'])
    .where('tenantId', '=', qctx.tenantId)
    .where('partId', '=', input.partId)
    .orderBy('position')
    .execute();
  const movements = await storeMovements(qctx)
    .where('partId', '=', input.partId)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(MOVEMENTS_SHOWN)
    .execute();
  return {
    rows: [{ ...toPart(row), models, movements: await toMovements(qctx, movements) }],
    nextCursor: null,
  };
}

export const getPartQuery = {
  name: 'getPart',
  permission: INVENTORY_PERMISSION.read,
  input: getPartInput,
  handler: getPartHandler,
} as const;

// ── partsForUse ────────────────────────────────────────────────────────────────────────────────

export const partsForUseInput = z
  .object({ useKind: z.enum(PART_USE_KINDS), useId: z.string().min(1) })
  .strict();
export type PartsForUseInput = z.input<typeof partsForUseInput>;

/** The parts one use (a servisan) has drawn on, and its takes and put-backs. */
export async function partsForUseHandler(
  input: z.output<typeof partsForUseInput>,
  qctx: Qctx,
): Promise<QueryPage<PartsForUseRow>> {
  const raw = await storeMovements(qctx)
    .where('useKind', '=', input.useKind)
    .where('useId', '=', input.useId)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const movements = await toMovements(qctx, raw);
  const partIds = [...new Set(movements.map((movement) => movement.partId))];
  const parts =
    partIds.length === 0 ? [] : (await partsWithStock(qctx, partIds).execute()).map(toPart);
  const out = new Map<string, number>();
  for (const movement of movements) {
    out.set(movement.partId, (out.get(movement.partId) ?? 0) - movement.qty);
  }
  return {
    rows: [
      {
        parts: parts
          .map((part) => ({
            partId: part.id,
            name: part.name,
            code: part.code,
            out: out.get(part.id) ?? 0,
            onHand: part.onHand,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        movements,
      },
    ],
    nextCursor: null,
  };
}

export const partsForUseQuery = {
  name: 'partsForUse',
  permission: INVENTORY_PERMISSION.read,
  input: partsForUseInput,
  handler: partsForUseHandler,
} as const;

// ── partsFitting ───────────────────────────────────────────────────────────────────────────────

export const partsFittingInput = z
  .object({
    brand: z.string().trim().max(60),
    model: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type PartsFittingInput = z.input<typeof partsFittingInput>;

/**
 * The parts on the list that fit one phone model, for the take step to offer first: a servisan for
 * an Oppo A57 shows the A57 parts before anyone types. Matched on the compacted spelling, so
 * "OPPO A-57" finds parts picked as "Oppo A57"; a part listed by model alone matches on the model.
 */
export async function partsFittingHandler(
  input: z.output<typeof partsFittingInput>,
  qctx: Qctx,
): Promise<QueryPage<PartRow>> {
  const keys = [compactModel(input.brand, input.model), compactModel(input.model)].filter(
    (key) => key !== '',
  );
  const ids = (
    await qctx.db
      .selectFrom('inventoryPartFits')
      .select('partId')
      .distinct()
      .where('tenantId', '=', qctx.tenantId)
      .where('modelKey', 'in', keys)
      .execute()
  ).map((row) => row.partId);
  if (ids.length === 0) return { rows: [], nextCursor: null };
  const rows = await partsWithStock(qctx, ids)
    .where('p.archived', '=', 0)
    .orderBy(sql`lower(p.name)`)
    .limit(input.limit)
    .execute();
  return { rows: rows.map(toPart), nextCursor: null };
}

export const partsFittingQuery = {
  name: 'partsFitting',
  permission: INVENTORY_PERMISSION.read,
  input: partsFittingInput,
  handler: partsFittingHandler,
} as const;
