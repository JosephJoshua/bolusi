// What a customer's status page shows for one servisan (product-scope.md, "Customers follow their
// repair online"), read from the server's records. Dialect-neutral like the rules, though only the
// server runs it: the page reads what the store has synced, so it is as fresh as the last sync.
//
// The servisan is found by its status link code before this runs (the server's definer lookup), so
// every read here is pinned to that servisan's store.
import type { Kysely } from 'kysely';

import {
  STATUS_PAGE_GRACE_MS,
  type PublicRepairStatus,
  type RepairStatusStep,
} from '@bolusi/schemas';

import type { MoneyDatabase } from '../money/schema.js';
import { paidOnDocumentSql } from '../money/queries.js';
import { REPAIR_OP, type DeviceLocation, type RepairOutcome } from './constants.js';
import { ticketStatus } from './flows.js';
import { warrantyUntil, type RecordedRepairType } from './intake-options.js';
import { REPAIR_DOCUMENT_KIND, ticketCharge } from './money-document.js';
import type { RepairDatabase } from './schema.js';

type Db = Kysely<RepairDatabase & MoneyDatabase>;

/** The history events a customer sees, as the step each one moved the servisan to. */
const STEP_OF_EVENT: Readonly<Record<string, RepairStatusStep>> = {
  [REPAIR_OP.ticketOpened]: 'received',
  [REPAIR_OP.workStarted]: 'in_repair',
  [REPAIR_OP.workPaused]: 'waiting_for_parts',
  [REPAIR_OP.markedRepaired]: 'repaired',
  [REPAIR_OP.ticketCancelled]: 'cancelled',
  [REPAIR_OP.deviceReturned]: 'returned',
};

/** Postgres hands `bigint` columns back as strings. */
const num = (value: number | string): number => Number(value);
const numOrNull = (value: number | string | null): number | null =>
  value === null ? null : Number(value);

/**
 * When the page stops showing the servisan: a while after its warranty ends, or after the phone went
 * home when it has none. Null while the phone is in the store.
 */
export function statusPageEndsAt(
  repairTypes: readonly Pick<RecordedRepairType, 'warrantyDays'>[],
  returnedAt: number | null,
): number | null {
  if (returnedAt === null) return null;
  return (warrantyUntil(repairTypes, returnedAt) ?? returnedAt) + STATUS_PAGE_GRACE_MS;
}

export type CustomerStatusRead =
  | { readonly kind: 'found'; readonly status: PublicRepairStatus }
  | { readonly kind: 'ended' }
  | { readonly kind: 'missing' };

/**
 * The customer's view of one servisan, or why there is none. `storeName` is the store's own name,
 * shown when the owner has not set another for the slips.
 */
export async function readCustomerStatus(
  db: Db,
  lookup: { readonly tenantId: string; readonly storeId: string; readonly ticketId: string },
  storeName: string,
  now: number,
): Promise<CustomerStatusRead> {
  const ticket = await db
    .selectFrom('repairTickets')
    .select([
      'ticketNumber',
      'deviceBrand',
      'deviceModel',
      'outcome',
      'location',
      'quoteTotal',
      'cancelFee',
      'estimatedReadyAt',
      'returnedAt',
      'repairTypesJson',
      'updatedAt',
      paidOnDocumentSql(REPAIR_DOCUMENT_KIND, 'repairTickets.id', 'repairTickets.storeId').as(
        'paid',
      ),
    ])
    .where('id', '=', lookup.ticketId)
    .where('tenantId', '=', lookup.tenantId)
    .where('storeId', '=', lookup.storeId)
    .executeTakeFirst();
  if (ticket === undefined) return { kind: 'missing' };

  const repairTypes = JSON.parse(ticket.repairTypesJson) as RecordedRepairType[];
  const returnedAt = numOrNull(ticket.returnedAt);
  const endsAt = statusPageEndsAt(repairTypes, returnedAt);
  if (endsAt !== null && now > endsAt) return { kind: 'ended' };

  const [events, proposals, settings] = await Promise.all([
    db
      .selectFrom('repairTicketEvents')
      .select(['kind', 'at'])
      .where('ticketId', '=', lookup.ticketId)
      .where('storeId', '=', lookup.storeId)
      .orderBy('at')
      .orderBy('id')
      .execute(),
    db
      .selectFrom('repairQuoteLines')
      .select(['description', 'amount'])
      .where('ticketId', '=', lookup.ticketId)
      .where('storeId', '=', lookup.storeId)
      .where('status', '=', 'proposed')
      .orderBy('createdAt')
      .orderBy('id')
      .execute(),
    db
      .selectFrom('repairStorePrintSettings')
      .select(['name', 'address', 'phone'])
      .where('storeId', '=', lookup.storeId)
      .executeTakeFirst(),
  ]);

  const steps: { step: RepairStatusStep; at: number }[] = [];
  for (const event of events) {
    const step = STEP_OF_EVENT[event.kind];
    if (step === undefined || steps[steps.length - 1]?.step === step) continue;
    steps.push({ step, at: num(event.at) });
  }

  // Before a repair's outcome is settled its bill is the agreed price so far.
  const charge = ticketCharge(ticket);
  const status: PublicRepairStatus = {
    store: {
      name: settings?.name ?? storeName,
      address: settings?.address ?? '',
      phone: settings?.phone ?? '',
    },
    ticketNumber: ticket.ticketNumber,
    device: [ticket.deviceBrand, ticket.deviceModel].filter((part) => part.trim() !== '').join(' '),
    status: ticketStatus({
      outcome: ticket.outcome as RepairOutcome,
      location: ticket.location as DeviceLocation,
    }),
    steps,
    estimatedReadyAt: numOrNull(ticket.estimatedReadyAt),
    money: {
      total: charge === null ? num(ticket.quoteTotal) : charge.amount,
      paid: num(ticket.paid ?? 0),
    },
    pendingPrices: proposals.map((line) => ({
      description: line.description,
      amount: num(line.amount),
    })),
    repairTypes: repairTypes.map(({ item, label, warrantyDays }) => ({
      item,
      label,
      warrantyDays,
    })),
    returnedAt,
    updatedAt: num(ticket.updatedAt),
  };
  return { kind: 'found', status };
}
