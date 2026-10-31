// The `repair` queries. Every read is scoped to the runtime-minted tenant and store, never to
// anything in the input or cursor. They run on the device, where customer names and phones are
// decrypted transparently by the connection; search goes through the shared fuzzy index (search.ts).
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import {
  decodeCursor,
  DomainError,
  fetchKeysetPage,
  keysetPredicate,
  searchIndexFor,
  type QueryContext,
  type QueryPage,
  type ReadonlyProjectionDb,
} from '@bolusi/core';

import {
  DEFAULT_UNCOLLECTED_DAYS,
  DEVICE_LOCATIONS,
  IN_PROGRESS_OUTCOMES,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_OP,
  REPAIR_OUTCOMES,
  REPAIR_PERMISSION,
  REPAIR_TICKET_ENTITY,
  type ChecklistState,
  type DeviceLocation,
  type QuoteLineKind,
  type QuoteLineStatus,
  type RepairOutcome,
  type SlipKind,
} from './constants.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  INTAKE_OPTION_LISTS,
  NOTHING_HIDDEN,
  recordedOption,
  type IntakeOption,
  type IntakeOptionList,
  type IntakeOptionSettings,
  type RecordedRepairType,
} from './intake-options.js';
import { userNames } from '../shared/user-names.js';
import { paidOnDocumentSql, reducedOnDocumentSql } from '../money/queries.js';
import { CASH_ACCOUNT, paymentAccountIdOf } from '../money/constants.js';
import { refundSplit } from '../money/rules.js';
import { amountOwed } from './flows.js';
import type { MoneyDatabase } from '../money/schema.js';
import { REPAIR_DOCUMENT_KIND } from './money-document.js';
import type { RepairDatabase } from './schema.js';
import { customerSearchSource, ticketSearchSource } from './search.js';
import { deviceCode } from './ticket-number.js';

type Qctx = QueryContext<RepairDatabase>;

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly createdAt: number;
}

export interface TicketSummaryRow {
  readonly id: string;
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly deviceBrand: string;
  readonly deviceModel: string;
  readonly deviceColor: string;
  readonly deviceImei: string | null;
  readonly complaint: string;
  readonly outcome: RepairOutcome;
  /** Why the outcome is what it is: waiting-for-parts note, cancel reason, repair note. */
  readonly outcomeNote: string | null;
  readonly location: DeviceLocation;
  readonly technicianId: string | null;
  /** Display name from the device's user directory; null when unknown. */
  readonly technicianName: string | null;
  readonly quoteTotal: number;
  readonly estimatedReadyAt: number | null;
  /** Technician proposals waiting for the cashier. */
  readonly pendingProposals: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** What the customer pays for a cancelled servisan; null when not cancelled or cancelled before fees. */
  readonly cancelFee: number | null;
  /** The store's fee in force at that cancel, so a changed fee stands out. */
  readonly cancelStandardFee: number | null;
  readonly cancelledBy: string | null;
  readonly cancelledByName: string | null;
  readonly cancelledAt: number | null;
  /**
   * Integer IDR the customer has paid so far, less what went back (the money ledger): the DP
   * before handover. Null when nothing was.
   */
  readonly downPayment: number | null;
  /** What an owner took off the bill after it was charged (the money ledger); 0 when nothing. */
  readonly reduced: number;
  /** When the phone was last ready to collect (repaired or cancelled); null while worked on. */
  readonly readyAt: number | null;
}

export interface QuoteLineRow {
  readonly id: string;
  readonly kind: QuoteLineKind;
  readonly description: string;
  readonly amount: number;
  readonly status: QuoteLineStatus;
  readonly reason: string | null;
  readonly customerAgreed: boolean | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly decidedBy: string | null;
  readonly decidedAt: number | null;
  readonly decisionNote: string | null;
}

export interface TicketPhotoRow {
  readonly slot: string;
  readonly mediaId: string;
  readonly mediaSha256: string;
  readonly mediaMime: string;
  readonly capturedAt: number;
}

export interface TicketEventRow {
  readonly id: string;
  readonly kind: string;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly at: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * A list item as a ticket recorded it: its id and the name it showed then, or null when that was the
 * built-in app name (and always for tickets opened before the lists were editable).
 */
export interface RecordedOption {
  readonly item: string;
  readonly label: string | null;
}

/** An intake photo angle a ticket asked for, in order. */
export interface IntakePhotoAngle {
  readonly slot: string;
  readonly label: string | null;
}

/** The servisan a warranty claim is on: its number, and what its warranty counts from. */
export interface ClaimedTicket {
  readonly id: string;
  readonly ticketNumber: string;
  readonly repairTypes: readonly RecordedRepairType[];
  readonly returnedAt: number | null;
}

export interface TicketRefund {
  readonly account: string;
  readonly name: string | null;
  readonly amount: number;
}

export interface TicketDetailRow extends TicketSummaryRow {
  readonly devicePasscode: string | null;
  readonly intakeNotes: string;
  readonly checklist: readonly (RecordedOption & { state: ChecklistState; note: string })[];
  readonly peripherals: readonly RecordedOption[];
  /** What is being repaired, with each type's warranty as recorded; none on older tickets. */
  readonly repairTypes: readonly RecordedRepairType[];
  /** The servisan this one is a warranty claim on; null for an ordinary servisan. */
  readonly claimOfTicketId: string | null;
  /** That servisan, with the types and pickup its warranty counts from. */
  readonly claimOf: ClaimedTicket | null;
  /** The warranty claims opened on this servisan, oldest first. */
  readonly claims: readonly { readonly id: string; readonly ticketNumber: string }[];
  readonly intakePhotos: readonly IntakePhotoAngle[];
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly returnedBy: string | null;
  readonly returnedByName: string | null;
  readonly returnedAt: number | null;
  /** A technician has started work on it at least once, so the after-work cancellation fee applies. */
  readonly workStarted: boolean;
  /** How many times each slip was printed or shared, so the next one is marked as a reprint. */
  readonly slipPrints: Readonly<Record<SlipKind, number>>;
  /**
   * What goes back to the customer at handover, through each method that overpaid
   * (`refundSplit`), as the handover records it; empty when nothing does or once handed back.
   * `name` is the method's name, null for cash.
   */
  readonly refunds: readonly TicketRefund[];
  readonly quoteLines: readonly QuoteLineRow[];
  readonly photos: readonly TicketPhotoRow[];
  readonly events: readonly TicketEventRow[];
}

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────

function summaryQuery(qctx: Qctx) {
  return qctx.db
    .selectFrom('repairTickets as t')
    .innerJoin('repairCustomers as c', 'c.id', 't.customerId')
    .select((eb) => [
      't.id',
      't.ticketNumber',
      't.customerId',
      'c.name as customerName',
      'c.phone as customerPhone',
      't.deviceBrand',
      't.deviceModel',
      't.deviceColor',
      't.deviceImei',
      't.complaint',
      't.outcome',
      't.outcomeNote',
      't.location',
      't.technicianId',
      't.quoteTotal',
      't.estimatedReadyAt',
      't.createdAt',
      't.updatedAt',
      't.cancelFee',
      't.cancelStandardFee',
      't.cancelledBy',
      't.cancelledAt',
      paidOnDocumentSql(REPAIR_DOCUMENT_KIND, 't.id', 't.storeId').as('downPayment'),
      reducedOnDocumentSql(REPAIR_DOCUMENT_KIND, 't.id', 't.storeId').as('reduced'),
      't.readyAt',
      eb
        .selectFrom('repairQuoteLines as l')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('l.ticketId', '=', 't.id')
        .where('l.status', '=', 'proposed')
        .as('pendingProposals'),
    ])
    .where('t.tenantId', '=', qctx.tenantId)
    .where('t.storeId', '=', qctx.storeId);
}

type RawSummary = Awaited<ReturnType<ReturnType<typeof summaryQuery>['execute']>>[number];

function toSummary(row: RawSummary, names: Map<string, string>): TicketSummaryRow {
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    deviceBrand: row.deviceBrand,
    deviceModel: row.deviceModel,
    deviceColor: row.deviceColor,
    deviceImei: row.deviceImei,
    complaint: row.complaint,
    outcome: row.outcome as RepairOutcome,
    outcomeNote: row.outcomeNote,
    location: row.location as DeviceLocation,
    technicianId: row.technicianId,
    technicianName: row.technicianId === null ? null : (names.get(row.technicianId) ?? null),
    quoteTotal: Number(row.quoteTotal),
    estimatedReadyAt: row.estimatedReadyAt === null ? null : Number(row.estimatedReadyAt),
    pendingProposals: Number(row.pendingProposals ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    cancelFee: row.cancelFee === null ? null : Number(row.cancelFee),
    cancelStandardFee: row.cancelStandardFee === null ? null : Number(row.cancelStandardFee),
    cancelledBy: row.cancelledBy,
    cancelledByName: row.cancelledBy === null ? null : (names.get(row.cancelledBy) ?? null),
    cancelledAt: row.cancelledAt === null ? null : Number(row.cancelledAt),
    downPayment:
      row.downPayment === null || Number(row.downPayment) === 0 ? null : Number(row.downPayment),
    reduced: Number(row.reduced ?? 0),
    readyAt: row.readyAt === null ? null : Number(row.readyAt),
  };
}

async function toSummaries(qctx: Qctx, rows: readonly RawSummary[]): Promise<TicketSummaryRow[]> {
  const names = await userNames(
    qctx.db,
    rows.flatMap((row) => [row.technicianId, row.cancelledBy]),
  );
  return rows.map((row) => toSummary(row, names));
}

// ── listTickets ────────────────────────────────────────────────────────────────────────────────

const ticketFilter = z
  .object({
    outcomes: z.array(z.enum(REPAIR_OUTCOMES)).min(1).optional(),
    location: z.enum(DEVICE_LOCATIONS).optional(),
    technicianId: z.string().min(1).optional(),
    /** Any of these technicians; with `unassigned`, tickets nobody holds yet count too. */
    technicianIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    unassigned: z.boolean().optional(),
    customerId: z.string().min(1).optional(),
    /** Only these servisan (the Kas unpaid list naming its customers). */
    ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    hasPendingProposals: z.boolean().optional(),
    /** Received at or after this time (epoch ms). */
    receivedFrom: z.number().int().nonnegative().optional(),
    /** Received before this time (epoch ms). */
    receivedBefore: z.number().int().nonnegative().optional(),
    /** Any of these brands, as the board's brand list offers them (case does not matter). */
    brands: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
    /** Ready to collect before this time (epoch ms): with the outcomes and location, not collected. */
    readyBefore: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Sorts a cursor can page through; the column sorts page by offset (a table's page numbers). No
 * sort by customer name: names are encrypted at rest, so SQL would order the ciphertext.
 */
const CURSOR_SORTS = [
  'createdAt.desc',
  'createdAt.asc',
  'cancelledAt.desc',
  'readyAt.asc',
] as const;
const COLUMN_SORTS = [
  'number.asc',
  'number.desc',
  'total.asc',
  'total.desc',
  'readyBy.asc',
  'readyBy.desc',
] as const;

export const listTicketsInput = z
  .object({
    filter: ticketFilter.optional(),
    /**
     * `cancelledAt.desc` lists only cancelled tickets, latest cancel first (the owner's view);
     * `readyAt.asc` the longest waiting first (phones not collected), with `filter.readyBefore`.
     */
    sort: z.enum([...CURSOR_SORTS, ...COLUMN_SORTS]).default('createdAt.desc'),
    cursor: z.string().optional(),
    /** Rows to skip, for a table that jumps to a page number. Not with a cursor. */
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((input) => input.cursor === undefined || input.offset === undefined, {
    message: 'cursor and offset cannot be combined',
  })
  .refine(
    (input) =>
      input.cursor === undefined || (CURSOR_SORTS as readonly string[]).includes(input.sort),
    { message: 'this sort pages by offset, not by cursor' },
  )
  // The cut-off is what leaves out tickets never finished, so the count with the same filter agrees.
  .refine((input) => input.sort !== 'readyAt.asc' || input.filter?.readyBefore !== undefined, {
    message: 'readyAt.asc needs filter.readyBefore',
  });

export type ListTicketsInput = z.infer<typeof listTicketsInput>;
export type TicketFilter = z.infer<typeof ticketFilter>;
export type TicketSort = ListTicketsInput['sort'];

/** The store's tickets narrowed by `filter`; shared by the list and its count so they agree. */
function filteredSummaries(qctx: Qctx, filter: TicketFilter, cancelledOnly: boolean) {
  let query = summaryQuery(qctx);
  if (cancelledOnly) query = query.where('t.cancelledAt', 'is not', null);
  if (filter.outcomes !== undefined) query = query.where('t.outcome', 'in', filter.outcomes);
  if (filter.location !== undefined) query = query.where('t.location', '=', filter.location);
  if (filter.technicianId !== undefined) {
    query = query.where('t.technicianId', '=', filter.technicianId);
  }
  const { technicianIds, unassigned } = filter;
  if (technicianIds !== undefined) {
    query = query.where((eb) =>
      unassigned === true
        ? eb.or([eb('t.technicianId', 'in', technicianIds), eb('t.technicianId', 'is', null)])
        : eb('t.technicianId', 'in', technicianIds),
    );
  } else if (unassigned === true) {
    query = query.where('t.technicianId', 'is', null);
  }
  if (filter.customerId !== undefined) query = query.where('t.customerId', '=', filter.customerId);
  if (filter.ids !== undefined) query = query.where('t.id', 'in', filter.ids);
  if (filter.hasPendingProposals === true) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('repairQuoteLines as l')
          .select('l.id')
          .whereRef('l.ticketId', '=', 't.id')
          .where('l.status', '=', 'proposed'),
      ),
    );
  }
  if (filter.receivedFrom !== undefined) {
    query = query.where('t.createdAt', '>=', filter.receivedFrom);
  }
  if (filter.receivedBefore !== undefined) {
    query = query.where('t.createdAt', '<', filter.receivedBefore);
  }
  if (filter.readyBefore !== undefined) {
    query = query.where('t.readyAt', '<', filter.readyBefore);
  }
  if (filter.brands !== undefined) {
    // The brands come from `ticketBrands`, so this picks recorded values rather than matching
    // typed text; case is folded so "samsung" and "Samsung" are one brand.
    const brands = filter.brands.map((brand) => brand.trim().toLowerCase());
    query = query.where((eb) => eb(eb.fn('lower', ['t.deviceBrand']), 'in', brands));
  }
  return query;
}

/** The ORDER BY column behind each column sort, with the ticket id as the tie-breaker. */
const SORT_COLUMN = {
  number: sql.ref('t.ticketNumber'),
  // What the customer owes: a cancelled servisan's fee, never its repair price, less what an owner
  // took off it.
  total: sql`case when ${sql.ref('t.outcome')} = 'cancelled' then coalesce(${sql.ref('t.cancelFee')}, 0) else ${sql.ref('t.quoteTotal')} end - coalesce(${reducedOnDocumentSql(REPAIR_DOCUMENT_KIND, 't.id', 't.storeId')}, 0)`,
  readyBy: sql.ref('t.estimatedReadyAt'),
  createdAt: sql.ref('t.createdAt'),
  cancelledAt: sql.ref('t.cancelledAt'),
  readyAt: sql.ref('t.readyAt'),
} as const;

export async function listTicketsHandler(
  input: ListTicketsInput,
  qctx: Qctx,
): Promise<QueryPage<TicketSummaryRow>> {
  const filter = input.filter ?? {};
  const byCancel = input.sort === 'cancelledAt.desc';
  const byReady = input.sort === 'readyAt.asc';
  const query = filteredSummaries(qctx, filter, byCancel);

  if (!(CURSOR_SORTS as readonly string[]).includes(input.sort) || input.offset !== undefined) {
    const [key, direction] = input.sort.split('.') as [string, 'asc' | 'desc'];
    const column = SORT_COLUMN[key as keyof typeof SORT_COLUMN];
    const rows = await query
      .orderBy(sql`${column} ${sql.raw(direction)}`)
      .orderBy('t.createdAt', 'desc')
      .orderBy('t.id', 'desc')
      .limit(input.limit)
      .offset(input.offset ?? 0)
      .execute();
    return { rows: await toSummaries(qctx, rows), nextCursor: null };
  }

  const descending = input.sort !== 'createdAt.asc' && !byReady;
  const column = byCancel ? 't.cancelledAt' : byReady ? 't.readyAt' : 't.createdAt';
  let paged = query
    .orderBy(column, descending ? 'desc' : 'asc')
    .orderBy('t.id', descending ? 'desc' : 'asc');
  if (input.cursor !== undefined) {
    const position = decodeCursor(input.cursor, input.sort);
    paged = paged.where((eb) =>
      keysetPredicate(eb, { column, idColumn: 't.id', position, descending }),
    );
  }

  const { rows, nextCursor } = await fetchKeysetPage({
    fetch: (limitPlusOne) => paged.limit(limitPlusOne).execute(),
    limit: input.limit,
    sort: input.sort,
    cursorValues: (last) => [
      Number(byCancel ? last.cancelledAt : byReady ? last.readyAt : last.createdAt),
      last.id,
    ],
  });
  return { rows: await toSummaries(qctx, rows), nextCursor };
}

export const listTicketsQuery = {
  name: 'listTickets',
  permission: REPAIR_PERMISSION.read,
  input: listTicketsInput,
  handler: listTicketsHandler,
} as const;

// ── countTickets ───────────────────────────────────────────────────────────────────────────────

export const countTicketsInput = z
  .object({ filter: ticketFilter.optional(), cancelledOnly: z.boolean().optional() })
  .strict();
export type CountTicketsInput = z.infer<typeof countTicketsInput>;

/** How many tickets `listTickets` would list with the same filter: a table's "1–50 of 312". */
export async function countTicketsHandler(
  input: CountTicketsInput,
  qctx: Qctx,
): Promise<QueryPage<{ readonly count: number }>> {
  const row = await qctx.db
    .selectFrom(filteredSummaries(qctx, input.filter ?? {}, input.cancelledOnly === true).as('s'))
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();
  return { rows: [{ count: Number(row?.count ?? 0) }], nextCursor: null };
}

export const countTicketsQuery = {
  name: 'countTickets',
  permission: REPAIR_PERMISSION.read,
  input: countTicketsInput,
  handler: countTicketsHandler,
} as const;

// ── ticketBrands ───────────────────────────────────────────────────────────────────────────────

export const ticketBrandsInput = z.object({}).strict();
export type TicketBrandsInput = z.infer<typeof ticketBrandsInput>;

/** The brands this store has taken in, most common first: the options of the brand filter. */
export async function ticketBrandsHandler(
  _input: TicketBrandsInput,
  qctx: Qctx,
): Promise<QueryPage<{ readonly brand: string; readonly count: number }>> {
  const rows = await qctx.db
    .selectFrom('repairTickets')
    .select((eb) => [eb.fn.min('deviceBrand').as('brand'), eb.fn.countAll<number>().as('count')])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .groupBy((eb) => eb.fn('lower', ['deviceBrand']))
    .orderBy('count', 'desc')
    .orderBy('brand')
    .execute();
  return {
    rows: rows
      .filter((row) => row.brand !== null && row.brand.trim() !== '')
      .map((row) => ({ brand: row.brand!.trim(), count: Number(row.count) })),
    nextCursor: null,
  };
}

export const ticketBrandsQuery = {
  name: 'ticketBrands',
  permission: REPAIR_PERMISSION.read,
  input: ticketBrandsInput,
  handler: ticketBrandsHandler,
} as const;

// ── searchTickets ──────────────────────────────────────────────────────────────────────────────

export const searchTicketsInput = z
  .object({
    text: z.string().max(200),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export type SearchTicketsInput = z.infer<typeof searchTicketsInput>;

/** Fuzzy search across the store's tickets (search.ts), best match first. */
export async function searchTicketsHandler(
  input: SearchTicketsInput,
  qctx: Qctx,
): Promise<QueryPage<TicketSummaryRow>> {
  const index = await searchIndexFor(qctx, ticketSearchSource);
  const ids = index.search(input.text, input.limit).map((hit) => hit.id);
  if (ids.length === 0) return { rows: [], nextCursor: null };
  const found = new Map(
    (await summaryQuery(qctx).where('t.id', 'in', ids).execute()).map((row) => [row.id, row]),
  );
  const ranked = ids.map((id) => found.get(id)).filter((row) => row !== undefined);
  return { rows: await toSummaries(qctx, ranked), nextCursor: null };
}

export const searchTicketsQuery = {
  name: 'searchTickets',
  permission: REPAIR_PERMISSION.read,
  input: searchTicketsInput,
  handler: searchTicketsHandler,
} as const;

// ── customers ──────────────────────────────────────────────────────────────────────────────────

export const searchCustomersInput = searchTicketsInput;
export type SearchCustomersInput = z.infer<typeof searchCustomersInput>;

export async function searchCustomersHandler(
  input: SearchCustomersInput,
  qctx: Qctx,
): Promise<QueryPage<CustomerRow>> {
  const index = await searchIndexFor(qctx, customerSearchSource);
  const ids = index.search(input.text, input.limit).map((hit) => hit.id);
  if (ids.length === 0) return { rows: [], nextCursor: null };
  const rows = await qctx.db
    .selectFrom('repairCustomers')
    .select(['id', 'name', 'phone', 'createdAt'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('id', 'in', ids)
    .execute();
  const found = new Map(rows.map((row) => [row.id, { ...row, createdAt: Number(row.createdAt) }]));
  return {
    rows: ids.map((id) => found.get(id)).filter((row) => row !== undefined),
    nextCursor: null,
  };
}

export const searchCustomersQuery = {
  name: 'searchCustomers',
  permission: REPAIR_PERMISSION.read,
  input: searchCustomersInput,
  handler: searchCustomersHandler,
} as const;

export const getCustomerInput = z.object({ customerId: z.string().min(1) }).strict();
export type GetCustomerInput = z.infer<typeof getCustomerInput>;

export async function getCustomerHandler(
  input: GetCustomerInput,
  qctx: Qctx,
): Promise<QueryPage<CustomerRow>> {
  const row = await qctx.db
    .selectFrom('repairCustomers')
    .select(['id', 'name', 'phone', 'createdAt'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('id', '=', input.customerId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: REPAIR_CUSTOMER_ENTITY, entityId: input.customerId },
      `no customer ${input.customerId} is visible in this scope`,
    );
  }
  return { rows: [{ ...row, createdAt: Number(row.createdAt) }], nextCursor: null };
}

export const getCustomerQuery = {
  name: 'getCustomer',
  permission: REPAIR_PERMISSION.read,
  input: getCustomerInput,
  handler: getCustomerHandler,
} as const;

// ── getTicket ──────────────────────────────────────────────────────────────────────────────────

export const getTicketInput = z.object({ ticketId: z.string().min(1) }).strict();
export type GetTicketInput = z.infer<typeof getTicketInput>;

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The angles a ticket asked for; tickets from before the editable list had the six defaults. */
function intakePhotoAngles(json: string | null): readonly IntakePhotoAngle[] {
  if (json === null) {
    return DEFAULT_INTAKE_OPTIONS.photoAngles.map(({ id }) => ({ slot: id, label: null }));
  }
  return parseJson<IntakePhotoAngle[]>(json, []);
}

/**
 * What a servisan's handover would give back through each method: what was paid beyond the bill
 * (`amountOwed`), split as `returnDevice` records it.
 */
async function ticketRefunds(qctx: Qctx, ticket: TicketSummaryRow): Promise<TicketRefund[]> {
  const db = qctx.db as unknown as Kysely<MoneyDatabase>;
  const entries = (
    await db
      .selectFrom('moneyEntries')
      .select(['kind', 'account', 'amount', 'voidedBy'])
      .where('storeId', '=', qctx.storeId ?? '')
      .where('documentKind', '=', REPAIR_DOCUMENT_KIND)
      .where('documentId', '=', ticket.id)
      .orderBy('createdAt')
      .orderBy('id')
      .execute()
  ).map((entry) => ({ ...entry, amount: Number(entry.amount) }));
  const bill = amountOwed(ticket);
  const credit = (ticket.downPayment ?? 0) - bill;
  const split =
    ticket.location === 'returned' || credit <= 0 ? [] : refundSplit(entries, credit, bill);
  const ids = split.flatMap(({ account }) => paymentAccountIdOf(account) ?? []);
  const names =
    ids.length === 0
      ? []
      : await db
          .selectFrom('moneyAccounts')
          .select(['id', 'name'])
          .where('tenantId', '=', qctx.tenantId)
          .where('id', 'in', ids)
          .execute();
  return split.map((refund) => ({
    ...refund,
    name:
      names.find((row) => row.id === paymentAccountIdOf(refund.account))?.name ??
      (refund.account === CASH_ACCOUNT ? null : refund.account),
  }));
}

export async function getTicketHandler(
  input: GetTicketInput,
  qctx: Qctx,
): Promise<QueryPage<TicketDetailRow>> {
  const summary = await summaryQuery(qctx).where('t.id', '=', input.ticketId).executeTakeFirst();
  if (summary === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: REPAIR_TICKET_ENTITY, entityId: input.ticketId },
      `no repair ticket ${input.ticketId} is visible in this scope`,
    );
  }

  const detail = await qctx.db
    .selectFrom('repairTickets')
    .select([
      'devicePasscode',
      'intakeNotes',
      'checklistJson',
      'peripheralsJson',
      'repairTypesJson',
      'claimOfTicketId',
      'intakePhotosJson',
      'createdBy',
      'returnedBy',
      'returnedAt',
    ])
    .where('id', '=', input.ticketId)
    .executeTakeFirstOrThrow();

  const claimed =
    detail.claimOfTicketId === null
      ? undefined
      : await qctx.db
          .selectFrom('repairTickets')
          .select(['id', 'ticketNumber', 'repairTypesJson', 'returnedAt'])
          .where('id', '=', detail.claimOfTicketId)
          .where('tenantId', '=', qctx.tenantId)
          .where('storeId', '=', qctx.storeId)
          .executeTakeFirst();
  const claims = await qctx.db
    .selectFrom('repairTickets')
    .select(['id', 'ticketNumber'])
    .where('claimOfTicketId', '=', input.ticketId)
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const lines = await qctx.db
    .selectFrom('repairQuoteLines')
    .selectAll()
    .where('ticketId', '=', input.ticketId)
    .where('storeId', '=', qctx.storeId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const photos = await qctx.db
    .selectFrom('repairTicketPhotos')
    .select(['slot', 'mediaId', 'mediaSha256', 'mediaMime', 'capturedAt'])
    .where('ticketId', '=', input.ticketId)
    .where('storeId', '=', qctx.storeId)
    .execute();

  const events = await qctx.db
    .selectFrom('repairTicketEvents')
    .select(['id', 'kind', 'actorId', 'at', 'detailJson'])
    .where('ticketId', '=', input.ticketId)
    .where('storeId', '=', qctx.storeId)
    .orderBy('at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const names = await userNames(qctx.db, [
    summary.technicianId,
    detail.createdBy,
    ...events.map((event) => event.actorId),
  ]);
  const refunds = await ticketRefunds(qctx, toSummary(summary, names));
  const slipPrints: Record<SlipKind, number> = { intake: 0, handover: 0 };
  for (const event of events) {
    if (event.kind !== REPAIR_OP.slipPrinted) continue;
    const { slip } = parseJson<{ slip?: string }>(event.detailJson, {});
    if (slip === 'intake' || slip === 'handover') slipPrints[slip] += 1;
  }

  return {
    rows: [
      {
        ...toSummary(summary, names),
        devicePasscode: detail.devicePasscode,
        intakeNotes: detail.intakeNotes,
        checklist: parseJson<{ state: ChecklistState; note: string }[]>(
          detail.checklistJson,
          [],
        ).map((check) => ({ ...recordedOption(check), state: check.state, note: check.note })),
        peripherals: parseJson<unknown[]>(detail.peripheralsJson, []).map(recordedOption),
        repairTypes: parseJson<RecordedRepairType[]>(detail.repairTypesJson, []),
        claimOfTicketId: detail.claimOfTicketId,
        claimOf:
          claimed === undefined
            ? null
            : {
                id: claimed.id,
                ticketNumber: claimed.ticketNumber,
                repairTypes: parseJson<RecordedRepairType[]>(claimed.repairTypesJson, []),
                returnedAt: claimed.returnedAt === null ? null : Number(claimed.returnedAt),
              },
        claims,
        intakePhotos: intakePhotoAngles(detail.intakePhotosJson),
        createdBy: detail.createdBy,
        createdByName: names.get(detail.createdBy) ?? null,
        returnedBy: detail.returnedBy,
        returnedByName: detail.returnedBy === null ? null : (names.get(detail.returnedBy) ?? null),
        returnedAt: detail.returnedAt === null ? null : Number(detail.returnedAt),
        workStarted: events.some((event) => event.kind === REPAIR_OP.workStarted),
        slipPrints,
        refunds,
        quoteLines: lines.map((line) => ({
          id: line.id,
          kind: line.kind as QuoteLineKind,
          description: line.description,
          amount: Number(line.amount),
          status: line.status as QuoteLineStatus,
          reason: line.reason,
          customerAgreed: line.customerAgreed === null ? null : Number(line.customerAgreed) === 1,
          createdBy: line.createdBy,
          createdAt: Number(line.createdAt),
          decidedBy: line.decidedBy,
          decidedAt: line.decidedAt === null ? null : Number(line.decidedAt),
          decisionNote: line.decisionNote,
        })),
        photos: photos.map((photo) => ({ ...photo, capturedAt: Number(photo.capturedAt) })),
        events: events.map((event) => ({
          id: event.id,
          kind: event.kind,
          actorId: event.actorId,
          actorName: names.get(event.actorId) ?? null,
          at: Number(event.at),
          detail: parseJson(event.detailJson, {}),
        })),
      },
    ],
    nextCursor: null,
  };
}

export const getTicketQuery = {
  name: 'getTicket',
  permission: REPAIR_PERMISSION.read,
  input: getTicketInput,
  handler: getTicketHandler,
} as const;

// ── technicianLoads ────────────────────────────────────────────────────────────────────────────

export const technicianLoadsInput = z.object({}).strict();
export type TechnicianLoadsInput = z.infer<typeof technicianLoadsInput>;

/** How many repairs each technician holds that are still in the store and being worked on. */
export async function technicianLoadsHandler(
  _input: TechnicianLoadsInput,
  qctx: Qctx,
): Promise<QueryPage<{ readonly technicianId: string; readonly load: number }>> {
  const rows = await qctx.db
    .selectFrom('repairTickets')
    .select((eb) => ['technicianId', eb.fn.countAll<number>().as('load')])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('outcome', 'in', IN_PROGRESS_OUTCOMES)
    .where('location', '=', 'in_store')
    .where('technicianId', 'is not', null)
    .groupBy('technicianId')
    .execute();
  return {
    rows: rows.map((row) => ({ technicianId: row.technicianId ?? '', load: Number(row.load) })),
    nextCursor: null,
  };
}

export const technicianLoadsQuery = {
  name: 'technicianLoads',
  permission: REPAIR_PERMISSION.read,
  input: technicianLoadsInput,
  handler: technicianLoadsHandler,
} as const;

// ── nextTicketCounter (the openTicket command's read seam) ─────────────────────────────────────

export const nextTicketCounterInput = z.object({ deviceId: z.string().min(1) }).strict();
export type NextTicketCounterInput = z.infer<typeof nextTicketCounterInput>;

/**
 * The next per-device counter for this device's ticket-number code. Takes the highest counter among
 * every visible ticket that shares the code, so a code collision with another synced device also
 * avoids a duplicate.
 *
 * One index seek, not a scan: these expressions match the client index
 * `idx_repair_tickets_device_counter` (db-client migration 7) exactly, so SQLite answers the MAX from
 * the index end. The counter is compared as an integer because `XXX-10000` sorts before `XXX-9999`
 * as text.
 */
export async function nextTicketCounterHandler(
  input: NextTicketCounterInput,
  qctx: Qctx,
): Promise<QueryPage<{ readonly counter: number }>> {
  const row = await maxTicketCounter(qctx.db, qctx, deviceCode(input.deviceId)).executeTakeFirst();
  return { rows: [{ counter: Number(row?.counter ?? 0) + 1 }], nextCursor: null };
}

/** The highest counter for a device code in one store. Exported so a test can check its plan. */
export function maxTicketCounter(
  db: ReadonlyProjectionDb<RepairDatabase>,
  scope: { readonly tenantId: string; readonly storeId: string | null },
  code: string,
) {
  return db
    .selectFrom('repairTickets')
    .select(
      // Only well-formed numbers count (4 to 9 digits after the code): a malformed number synced
      // from another device is NULL here instead of casting to 0 or saturating at INT64 max.
      sql<
        number | null
      >`MAX(CASE WHEN length(ticket_number) BETWEEN 8 AND 13 AND substr(ticket_number, 5) NOT GLOB '*[^0-9]*' THEN CAST(substr(ticket_number, 5) AS INTEGER) END)`.as(
        'counter',
      ),
    )
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where(sql<string>`substr(ticket_number, 1, 4)`, '=', `${code}-`);
}

export const nextTicketCounterQuery = {
  name: 'nextTicketCounter',
  permission: REPAIR_PERMISSION.intake,
  input: nextTicketCounterInput,
  handler: nextTicketCounterHandler,
} as const;

// ── intakeOptionSettings (the lists intake offers, and the owner's editor) ─────────────────────

export const intakeOptionSettingsInput = z.object({}).strict();

/**
 * The franchise's intake lists and what this store hides. A list the owner never saved is the
 * default one, so a new tenant's intake looks exactly like it did when the lists were code.
 */
export async function intakeOptionSettingsHandler(
  _input: z.infer<typeof intakeOptionSettingsInput>,
  qctx: Qctx,
): Promise<QueryPage<IntakeOptionSettings>> {
  const known = (list: string): list is IntakeOptionList =>
    (INTAKE_OPTION_LISTS as readonly string[]).includes(list);

  const lists: Record<IntakeOptionList, readonly IntakeOption[]> = { ...DEFAULT_INTAKE_OPTIONS };
  const franchise = await qctx.db
    .selectFrom('repairIntakeOptions')
    .select(['list', 'itemsJson'])
    .where('tenantId', '=', qctx.tenantId)
    .execute();
  for (const row of franchise) {
    if (known(row.list)) lists[row.list] = parseJson<IntakeOption[]>(row.itemsJson, []);
  }

  const hidden: Record<IntakeOptionList, readonly string[]> = { ...NOTHING_HIDDEN };
  const store = await qctx.db
    .selectFrom('repairStoreIntakeOptions')
    .select(['list', 'hiddenJson'])
    .where('storeId', '=', qctx.storeId)
    .execute();
  for (const row of store) {
    if (known(row.list)) hidden[row.list] = parseJson<string[]>(row.hiddenJson, []);
  }

  return { rows: [{ lists, hidden }], nextCursor: null };
}

export const intakeOptionSettingsQuery = {
  name: 'intakeOptionSettings',
  permission: REPAIR_PERMISSION.read,
  input: intakeOptionSettingsInput,
  handler: intakeOptionSettingsHandler,
} as const;

// ── cancelFees (what a cancelled servisan costs at this store) ───────────────────────────────

export interface CancelFees {
  /** Before any work started on the phone. */
  readonly beforeWork: number;
  /** Once a technician has started work on it. */
  readonly afterWork: number;
}

/**
 * The store's fee for cancelling this ticket now: after-work once work has ever started. A warranty
 * claim was free, so it costs nothing to cancel unless the owner sets a fee.
 */
export function standardCancelFee(
  ticket: Pick<TicketDetailRow, 'workStarted' | 'claimOfTicketId'>,
  fees: CancelFees,
): number {
  if (ticket.claimOfTicketId !== null) return 0;
  return ticket.workStarted ? fees.afterWork : fees.beforeWork;
}

/**
 * What a cancel at `fee` counts against a limited role's limit: a fee below the store's is a price
 * drop on the servisan, counted with the discounts already on it (`discounts`); otherwise nothing.
 * The same for the rule, an approval request and the step that decides whether to ask.
 */
export function cancelDrop(standard: number, fee: number, discounts: number): number {
  const drop = standard - fee;
  return drop > 0 ? drop + discounts : drop;
}

/**
 * How far below the store's fee a limited role may cut a cancel's fee without asking, or null when
 * it is not limited or has no room (any cut is then asked, and the step says so).
 */
export function cancelRoom(
  limit: number | null,
  standard: number | null,
  discounts: number,
): number | null {
  if (limit === null || standard === null || standard === 0) return null;
  const room = Math.min(limit - discounts, standard);
  return room > 0 ? room : null;
}

/** A store that never set its fees charges nothing, as before fees existed. */
export const NO_CANCEL_FEES: CancelFees = { beforeWork: 0, afterWork: 0 };

export const cancelFeesInput = z.object({}).strict();

export async function cancelFeesHandler(
  _input: z.infer<typeof cancelFeesInput>,
  qctx: Qctx,
): Promise<QueryPage<CancelFees>> {
  const row = await qctx.db
    .selectFrom('repairStoreCancelFees')
    .select(['beforeWork', 'afterWork'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .executeTakeFirst();
  const fees =
    row === undefined
      ? NO_CANCEL_FEES
      : { beforeWork: Number(row.beforeWork), afterWork: Number(row.afterWork) };
  return { rows: [fees], nextCursor: null };
}

export const cancelFeesQuery = {
  name: 'cancelFees',
  permission: REPAIR_PERMISSION.read,
  input: cancelFeesInput,
  handler: cancelFeesHandler,
} as const;

// ── uncollectedDays (when a phone nobody collected is flagged) ───────────────────────────────

export const uncollectedDaysInput = z.object({}).strict();

/** After how many days this store flags a ready phone still in the store; 60 until it sets one. */
export async function uncollectedDaysHandler(
  _input: z.infer<typeof uncollectedDaysInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly days: number }>> {
  const row = await qctx.db
    .selectFrom('repairStoreUncollected')
    .select('days')
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .executeTakeFirst();
  return {
    rows: [{ days: row === undefined ? DEFAULT_UNCOLLECTED_DAYS : Number(row.days) }],
    nextCursor: null,
  };
}

export const uncollectedDaysQuery = {
  name: 'uncollectedDays',
  permission: REPAIR_PERMISSION.read,
  input: uncollectedDaysInput,
  handler: uncollectedDaysHandler,
} as const;

// ── printSettings (what this store's slips print besides the servisan) ──────────────────────

export interface PrintSettings {
  /** The business name in large type; null prints the store's own name. */
  readonly name: string | null;
  readonly address: string;
  readonly phone: string;
  /** The logo picture, to fetch like any synced photo; null when there is none. */
  readonly logo: {
    readonly mediaId: string;
    readonly sha256: string;
    readonly mime: string;
  } | null;
  readonly logoOnDotMatrix: boolean;
  /** One term per line; null prints the app's default terms. */
  readonly intakeTerms: string | null;
  readonly handoverTerms: string | null;
}

/** A store that never set anything prints its name and the default terms. */
export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  name: null,
  address: '',
  phone: '',
  logo: null,
  logoOnDotMatrix: false,
  intakeTerms: null,
  handoverTerms: null,
};

export const printSettingsInput = z.object({}).strict();

export async function printSettingsHandler(
  _input: z.infer<typeof printSettingsInput>,
  qctx: Qctx,
): Promise<QueryPage<PrintSettings>> {
  const row = await qctx.db
    .selectFrom('repairStorePrintSettings')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .executeTakeFirst();
  const settings: PrintSettings =
    row === undefined
      ? DEFAULT_PRINT_SETTINGS
      : {
          name: row.name,
          address: row.address,
          phone: row.phone,
          logo:
            row.logoMediaId === null || row.logoSha256 === null || row.logoMime === null
              ? null
              : { mediaId: row.logoMediaId, sha256: row.logoSha256, mime: row.logoMime },
          logoOnDotMatrix: Number(row.logoOnDotMatrix) === 1,
          intakeTerms: row.intakeTerms,
          handoverTerms: row.handoverTerms,
        };
  return { rows: [settings], nextCursor: null };
}

export const printSettingsQuery = {
  name: 'printSettings',
  permission: REPAIR_PERMISSION.read,
  input: printSettingsInput,
  handler: printSettingsHandler,
} as const;
