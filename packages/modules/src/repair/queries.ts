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
  DEVICE_LOCATIONS,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_OUTCOMES,
  REPAIR_PERMISSION,
  REPAIR_TICKET_ENTITY,
  type ChecklistState,
  type DeviceLocation,
  type QuoteLineKind,
  type QuoteLineStatus,
  type RepairOutcome,
} from './constants.js';
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

export interface TicketDetailRow extends TicketSummaryRow {
  readonly devicePasscode: string | null;
  readonly intakeNotes: string;
  readonly checklist: readonly { item: string; state: ChecklistState; note: string }[];
  readonly peripherals: readonly string[];
  readonly outcomeNote: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly returnedBy: string | null;
  readonly returnedAt: number | null;
  readonly quoteLines: readonly QuoteLineRow[];
  readonly photos: readonly TicketPhotoRow[];
  readonly events: readonly TicketEventRow[];
}

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────

/** The client-only users directory, reached by narrow cast as notes' getNote does. */
interface UsersLookup {
  readonly usersDirectory: { readonly id: string; readonly name: string };
}

async function userNames(
  qctx: Qctx,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await (qctx.db as unknown as Pick<Kysely<UsersLookup>, 'selectFrom'>)
    .selectFrom('usersDirectory')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

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
      't.location',
      't.technicianId',
      't.quoteTotal',
      't.estimatedReadyAt',
      't.createdAt',
      't.updatedAt',
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
    location: row.location as DeviceLocation,
    technicianId: row.technicianId,
    technicianName: row.technicianId === null ? null : (names.get(row.technicianId) ?? null),
    quoteTotal: Number(row.quoteTotal),
    estimatedReadyAt: row.estimatedReadyAt === null ? null : Number(row.estimatedReadyAt),
    pendingProposals: Number(row.pendingProposals ?? 0),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

async function toSummaries(qctx: Qctx, rows: readonly RawSummary[]): Promise<TicketSummaryRow[]> {
  const names = await userNames(
    qctx,
    rows.map((row) => row.technicianId),
  );
  return rows.map((row) => toSummary(row, names));
}

// ── listTickets ────────────────────────────────────────────────────────────────────────────────

export const listTicketsInput = z
  .object({
    filter: z
      .object({
        outcomes: z.array(z.enum(REPAIR_OUTCOMES)).min(1).optional(),
        location: z.enum(DEVICE_LOCATIONS).optional(),
        technicianId: z.string().min(1).optional(),
        unassigned: z.boolean().optional(),
        customerId: z.string().min(1).optional(),
        hasPendingProposals: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sort: z.enum(['createdAt.desc', 'createdAt.asc']).default('createdAt.desc'),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListTicketsInput = z.infer<typeof listTicketsInput>;

export async function listTicketsHandler(
  input: ListTicketsInput,
  qctx: Qctx,
): Promise<QueryPage<TicketSummaryRow>> {
  const descending = input.sort === 'createdAt.desc';
  const filter = input.filter ?? {};
  let query = summaryQuery(qctx)
    .orderBy('t.createdAt', descending ? 'desc' : 'asc')
    .orderBy('t.id', descending ? 'desc' : 'asc');

  if (filter.outcomes !== undefined) query = query.where('t.outcome', 'in', filter.outcomes);
  if (filter.location !== undefined) query = query.where('t.location', '=', filter.location);
  if (filter.technicianId !== undefined) {
    query = query.where('t.technicianId', '=', filter.technicianId);
  }
  if (filter.unassigned === true) query = query.where('t.technicianId', 'is', null);
  if (filter.customerId !== undefined) query = query.where('t.customerId', '=', filter.customerId);
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

  if (input.cursor !== undefined) {
    const position = decodeCursor(input.cursor, input.sort);
    query = query.where((eb) =>
      keysetPredicate(eb, { column: 't.createdAt', idColumn: 't.id', position, descending }),
    );
  }

  const { rows, nextCursor } = await fetchKeysetPage({
    fetch: (limitPlusOne) => query.limit(limitPlusOne).execute(),
    limit: input.limit,
    sort: input.sort,
    cursorValues: (last) => [Number(last.createdAt), last.id],
  });
  return { rows: await toSummaries(qctx, rows), nextCursor };
}

export const listTicketsQuery = {
  name: 'listTickets',
  permission: REPAIR_PERMISSION.read,
  input: listTicketsInput,
  handler: listTicketsHandler,
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
      'outcomeNote',
      'createdBy',
      'returnedBy',
      'returnedAt',
    ])
    .where('id', '=', input.ticketId)
    .executeTakeFirstOrThrow();

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

  const names = await userNames(qctx, [
    summary.technicianId,
    detail.createdBy,
    ...events.map((event) => event.actorId),
  ]);

  return {
    rows: [
      {
        ...toSummary(summary, names),
        devicePasscode: detail.devicePasscode,
        intakeNotes: detail.intakeNotes,
        checklist: parseJson(detail.checklistJson, []),
        peripherals: parseJson(detail.peripheralsJson, []),
        outcomeNote: detail.outcomeNote,
        createdBy: detail.createdBy,
        createdByName: names.get(detail.createdBy) ?? null,
        returnedBy: detail.returnedBy,
        returnedAt: detail.returnedAt === null ? null : Number(detail.returnedAt),
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
