// The `repair` op rules: what must hold in the current records for each op to be recorded.
//
// Declared on each op type (operations.ts) and run on both sides (core module/op-rules.ts): the
// device's append path runs them on every op a command produces before saving, and the server runs
// them on every pushed op against its own records before accepting it. So these are the ONLY copy
// of the repair state rules: the commands compose ops and leave the refusing to these.
//
// Every read is constrained to the op's own store, so an op naming another store's ticket finds
// nothing. Reads are dialect-neutral (SQLite on the device, Postgres on the server); Postgres hands
// `bigint` columns back as strings, hence the `Number(...)` on money.
import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';

import { carriedRegistrations, defineRefusals, type DomainError, type OpRule } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import {
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_OP,
  REPAIR_PERMISSION,
  REPAIR_TICKET_ENTITY,
  type DeviceLocation,
  type QuoteLineKind,
  type QuoteLineStatus,
  type RepairOutcome,
  type WorkPhotoStage,
} from './constants.js';
import { MONEY_PERMISSION } from '../money/constants.js';
import { documentBalance, documentTotal } from '../money/rules.js';
import { intakeListProblems } from './intake-options.js';
import { REPAIR_DOCUMENT_KIND, repairMoneyDocument } from './money-document.js';
import type {
  deviceReturnedPayload,
  downPaymentReceivedPayload,
  intakeOptionsChangedPayload,
  quoteChangedPayload,
  quoteChangeProposedPayload,
  quoteProposalDeclinedPayload,
  slipPrintedPayload,
  technicianAssignedPayload,
  ticketOpenedPayload,
  workPhotosAddedPayload,
} from './operations.js';
import type { RepairDatabase } from './schema.js';
import { deviceCode, ticketCounter } from './ticket-number.js';

type Rule = OpRule<RepairDatabase>;
type Db = Parameters<Rule>[1]['db'];

function payloadOf<T>(op: SignedOperation): T {
  return op.payload as unknown as T;
}

/** Every reason a repair change is refused, each with its own copy at `repair.refusal.<reason>`. */
export const REPAIR_REFUSALS = defineRefusals('repair', [
  'alreadyRecorded',
  'customerNotFound',
  'ticketNotFound',
  'priceChangeNotFound',
  'wrongSign',
  'belowZero',
  'numberNotThisDevice',
  'numberUsed',
  'returned',
  'cancelled',
  'notStarted',
  'inRepair',
  'waitingForParts',
  'repaired',
  'notFinished',
  'alreadyYours',
  'alreadyAssigned',
  'notTechnician',
  'noTechnician',
  'needsBeforePhoto',
  'needsAfterPhoto',
  'priceChangeDecided',
  'priceChangeDifferent',
  'priceChangesPending',
  'invalidOptions',
  'notThisStore',
  'discountOwnerOnly',
  'customerAgreementMismatch',
  'downPaymentAboveTotal',
  'downPaymentRecorded',
  'notPaid',
  'unpaidOwnerOnly',
  'downPaymentRefunded',
] as const);
type RepairRefusal = (typeof REPAIR_REFUSALS.reasons)[number];
const { refuse } = REPAIR_REFUSALS;

/**
 * A line that lowers the price is a discount, whatever its kind: only owners may write one, so the
 * counter cannot charge the customer the full price and record less. A proposal counts too, so a
 * discount never waits on the board for an owner who is not there.
 */
async function requireDiscountPermission(
  op: SignedOperation,
  holdsPermission: Parameters<Rule>[1]['holdsPermission'],
  amounts: readonly number[],
): Promise<void> {
  if (!amounts.some((amount) => amount < 0)) return;
  if (await holdsPermission(op.userId, REPAIR_PERMISSION.discount)) return;
  throw refuse('discountOwnerOnly', {
    code: 'PERMISSION_DENIED',
    details: { permissionId: REPAIR_PERMISSION.discount },
    message: `user ${op.userId} cannot lower a price`,
  });
}

// ── shared checks (also used by the commands to word their own input errors) ─────────────────────

/** Parts and labour add to the price, discounts subtract; adjustments may go either way. */
export function checkLineSign(kind: QuoteLineKind, amount: number): void {
  const ok = kind === 'discount' ? amount <= 0 : kind === 'adjustment' ? true : amount >= 0;
  if (!ok) {
    throw refuse('wrongSign', {
      code: 'VALIDATION_FAILED',
      details: { field: 'amount', issue: `${kind} amount has the wrong sign` },
      message: `a ${kind} line cannot have amount ${amount}`,
    });
  }
}

/**
 * The agreed price can come down to nothing, but never below: the store would owe the customer.
 * Only a line that lowers the total is refused, so a total that offline merges already pushed
 * below zero can still be corrected upwards.
 */
export function checkTotal(current: number, change: number): void {
  const total = current + change;
  if (change < 0 && total < 0) {
    throw refuse('belowZero', {
      code: 'VALIDATION_FAILED',
      details: { field: 'amount', issue: 'the total price would be negative' },
      message: `the total price cannot be ${total}`,
    });
  }
}

/**
 * A down payment cannot be more than the price quoted, which catches an extra zero typed at the
 * counter. With no price yet (a total of 0) any amount is allowed: the customer may pay up front
 * before the technician has priced the repair.
 */
export function checkDownPayment(amount: number, total: number): void {
  if (total > 0 && amount > total) {
    throw refuse('downPaymentAboveTotal', {
      code: 'VALIDATION_FAILED',
      details: { field: 'downPayment', issue: 'the down payment is more than the price' },
      message: `a down payment of ${amount} is more than the total ${total}`,
    });
  }
}

/** The ticket fields the rules judge by. */
export interface TicketState {
  readonly id: string;
  readonly ticketNumber: string;
  readonly outcome: RepairOutcome;
  readonly location: DeviceLocation;
  readonly technicianId: string | null;
  readonly quoteTotal: number;
}

export function invalidTransition(
  ticket: TicketState,
  event: string,
  reason: RepairRefusal,
  why: string,
): DomainError {
  return refuse(reason, {
    details: {
      machine: REPAIR_TICKET_ENTITY,
      from: `${ticket.outcome}/${ticket.location}`,
      event,
      entityId: ticket.id,
    },
    message: `ticket ${ticket.ticketNumber}: ${why}`,
  });
}

/** Why a ticket in `outcome` cannot take this step: its current state, in the person's words. */
const OUTCOME_REFUSAL: Readonly<Record<RepairOutcome, RepairRefusal>> = {
  received: 'notStarted',
  in_repair: 'inRepair',
  waiting_for_parts: 'waitingForParts',
  repaired: 'repaired',
  cancelled: 'cancelled',
};

/** A ticket that is still being worked on: in the store and not cancelled. */
function requireOpen(ticket: TicketState, event: string): void {
  if (ticket.location === 'returned') {
    throw invalidTransition(ticket, event, 'returned', 'the device has already been returned');
  }
  if (ticket.outcome === 'cancelled') {
    throw invalidTransition(ticket, event, 'cancelled', 'the ticket is cancelled');
  }
}

function requireOutcome(
  ticket: TicketState,
  event: string,
  allowed: readonly RepairOutcome[],
): void {
  requireOpen(ticket, event);
  if (!allowed.includes(ticket.outcome)) {
    throw invalidTransition(
      ticket,
      event,
      OUTCOME_REFUSAL[ticket.outcome],
      `not allowed while ${ticket.outcome}`,
    );
  }
}

export function missingPhotos(stage: WorkPhotoStage, why: string): DomainError {
  return refuse(stage === 'before' ? 'needsBeforePhoto' : 'needsAfterPhoto', {
    code: 'VALIDATION_FAILED',
    details: { field: `${stage}Photos`, issue: 'at least one photo is required' },
    message: why,
  });
}

/** The outcomes work can be (re)started from: new, paused, or reopened after a repair. */
const STARTABLE: readonly RepairOutcome[] = ['received', 'waiting_for_parts', 'repaired'];

/** The outcomes each work-photo stage may be added in: before photos come with a (re)start. */
const PHOTO_STAGE_OUTCOMES: Readonly<Record<WorkPhotoStage, readonly RepairOutcome[]>> = {
  before: STARTABLE,
  after: ['in_repair'],
};

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

const NOT_FOUND: Readonly<Record<string, RepairRefusal>> = {
  [REPAIR_CUSTOMER_ENTITY]: 'customerNotFound',
  [REPAIR_TICKET_ENTITY]: 'ticketNotFound',
  repair_quote_line: 'priceChangeNotFound',
};

function notFound(entityType: string, entityId: string): DomainError {
  return refuse(NOT_FOUND[entityType] ?? 'ticketNotFound', {
    code: 'ENTITY_NOT_FOUND',
    details: { entityType, entityId },
  });
}

function alreadyRecorded(field: string, id: string): DomainError {
  return refuse('alreadyRecorded', {
    code: 'VALIDATION_FAILED',
    details: { field, issue: 'already exists' },
    message: `${field} ${id} already exists`,
  });
}

async function findTicket(db: Db, op: SignedOperation): Promise<TicketState | undefined> {
  const row = await db
    .selectFrom('repairTickets')
    .select(['id', 'ticketNumber', 'outcome', 'location', 'technicianId', 'quoteTotal'])
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    outcome: row.outcome as RepairOutcome,
    location: row.location as DeviceLocation,
    technicianId: row.technicianId,
    quoteTotal: Number(row.quoteTotal),
  };
}

async function loadTicket(db: Db, op: SignedOperation): Promise<TicketState> {
  const ticket = await findTicket(db, op);
  if (ticket === undefined) throw notFound(REPAIR_TICKET_ENTITY, op.entityId);
  return ticket;
}

/** Repair ops are store-scoped, so a null store never matches a row. */
function storeOf(op: SignedOperation): string {
  return op.storeId ?? '';
}

async function customerExists(db: Db, op: SignedOperation, customerId: string): Promise<boolean> {
  const row = await db
    .selectFrom('repairCustomers')
    .select('id')
    .where('id', '=', customerId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether a record with this id already exists anywhere the judging side can see. */
async function idTaken(
  db: Db,
  table: 'repairCustomers' | 'repairTickets' | 'repairQuoteLines',
  id: string,
): Promise<boolean> {
  return (
    (await db.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst()) !== undefined
  );
}

export interface QuoteLineState {
  readonly id: string;
  readonly kind: QuoteLineKind;
  readonly status: QuoteLineStatus;
}

async function findLine(
  db: Db,
  op: SignedOperation,
  lineId: string,
): Promise<QuoteLineState | undefined> {
  const row = await db
    .selectFrom('repairQuoteLines')
    .select(['id', 'kind', 'status'])
    .where('id', '=', lineId)
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, kind: row.kind as QuoteLineKind, status: row.status as QuoteLineStatus };
}

/** The open proposal `lineId` on `ticket`, or the error the command and the rule both raise. */
export function requireProposal(
  ticket: TicketState,
  line: { readonly id: string; readonly status: QuoteLineStatus } | undefined,
  lineId: string,
  event: string,
): void {
  if (line === undefined) throw notFound('repair_quote_line', lineId);
  if (line.status !== 'proposed') {
    throw invalidTransition(
      ticket,
      event,
      'priceChangeDecided',
      `quote line ${lineId} is ${line.status}`,
    );
  }
}

async function requireFreshLine(db: Db, ticket: TicketState, lineId: string, event: string) {
  if (await idTaken(db, 'repairQuoteLines', lineId)) {
    throw invalidTransition(
      ticket,
      event,
      'alreadyRecorded',
      `quote line ${lineId} already exists`,
    );
  }
}

async function hasWorkPhoto(db: Db, op: SignedOperation, stage: WorkPhotoStage, since = 0) {
  const row = await db
    .selectFrom('repairTicketPhotos')
    .select('slot')
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeOf(op))
    .where('slot', 'like', `${stage}:%`)
    .where('addedAt', '>=', since)
    .executeTakeFirst();
  return row !== undefined;
}

/** When work on the ticket was last (re)started, or 0 if never. */
async function lastStartedAt(db: Db, op: SignedOperation): Promise<number> {
  const row = await db
    .selectFrom('repairTicketEvents')
    .select((eb) => eb.fn.max('at').as('at'))
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeOf(op))
    .where('kind', '=', REPAIR_OP.workStarted)
    .executeTakeFirst();
  return row?.at === null || row?.at === undefined ? 0 : Number(row.at);
}

async function pendingProposals(db: Db, op: SignedOperation): Promise<number> {
  const row = await db
    .selectFrom('repairQuoteLines')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeOf(op))
    .where('status', '=', 'proposed')
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Whether this device already opened a ticket with this number. Bound to the device through the op
 * log, which both sides keep with the same columns: two devices may share a 3-letter code
 * (ticket-number.ts), and that rare collision must not refuse an honest ticket.
 */
async function deviceUsedNumber(
  db: Db,
  op: SignedOperation,
  ticketNumber: string,
  devices: readonly string[],
) {
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM repair_tickets t
    JOIN operations o ON o.entity_id = t.id AND o.type = ${op.type}
    WHERE t.store_id = ${storeOf(op)} AND t.ticket_number = ${ticketNumber}
      AND o.device_id IN (${sql.join(devices)})
    LIMIT 1
  `.execute(db);
  return rows.length > 0;
}

// ── the rules, one per op type ──────────────────────────────────────────────────────────────────

type Payload<S extends z.ZodType> = z.output<S>;

export const customerRegisteredRule: Rule = async (op, { db }) => {
  if (await idTaken(db, 'repairCustomers', op.entityId)) {
    throw alreadyRecorded('customerId', op.entityId);
  }
};

export const customerDetailsCorrectedRule: Rule = async (op, { db }) => {
  if (!(await customerExists(db, op, op.entityId))) {
    throw notFound(REPAIR_CUSTOMER_ENTITY, op.entityId);
  }
};

/**
 * A new ticket: a fresh id, a customer of this store, a price that adds up, and a ticket number
 * this device minted (its own code, or an earlier registration's it carried changes over from) and
 * has not used before. The number is printed for the customer, so it is the device's to mint offline
 * but never another device's to reuse.
 */
export const ticketOpenedRule: Rule = async (op, { db, holdsPermission }) => {
  const payload = payloadOf<Payload<typeof ticketOpenedPayload>>(op);
  if (await idTaken(db, 'repairTickets', op.entityId)) {
    throw alreadyRecorded('ticketId', op.entityId);
  }
  if (!(await customerExists(db, op, payload.customerId))) {
    throw notFound(REPAIR_CUSTOMER_ENTITY, payload.customerId);
  }
  for (const line of payload.quoteLines) checkLineSign(line.kind, line.amount);
  await requireDiscountPermission(
    op,
    holdsPermission,
    payload.quoteLines.map((line) => line.amount),
  );
  checkTotal(
    0,
    payload.quoteLines.reduce((sum, line) => sum + line.amount, 0),
  );
  for (const line of payload.quoteLines) {
    if (await idTaken(db, 'repairQuoteLines', line.lineId)) {
      throw alreadyRecorded('quoteLines', line.lineId);
    }
  }
  const number = payload.ticketNumber;
  // A re-enrolled phone carries over tickets its earlier registration numbered offline.
  const devices = await carriedRegistrations(db, op.deviceId);
  const minted = devices.some((device) => number.startsWith(`${deviceCode(device)}-`));
  if (!minted || ticketCounter(number) === null) {
    throw refuse('numberNotThisDevice', {
      code: 'VALIDATION_FAILED',
      details: { field: 'ticketNumber', issue: 'not minted by this device' },
      message: `ticket number ${number} does not belong to device ${op.deviceId}`,
    });
  }
  if (await deviceUsedNumber(db, op, number, devices)) {
    throw refuse('numberUsed', {
      code: 'VALIDATION_FAILED',
      details: { field: 'ticketNumber', issue: 'already used' },
      message: `ticket number ${number} is already used by this device`,
    });
  }
};

export const ticketClaimedRule: Rule = async (op, { db }) => {
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  if (ticket.technicianId === op.userId) {
    throw invalidTransition(ticket, op.type, 'alreadyYours', 'already yours');
  }
};

/**
 * Assign a technician. The picker only lists people who can do repair work; a crafted or stale
 * assignment must not park a customer's phone with someone who can never start it.
 */
export const technicianAssignedRule: Rule = async (op, { db, holdsPermission }) => {
  const { technicianId } = payloadOf<Payload<typeof technicianAssignedPayload>>(op);
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  if (ticket.technicianId === technicianId) {
    throw invalidTransition(ticket, op.type, 'alreadyAssigned', 'already assigned to them');
  }
  if (!(await holdsPermission(technicianId, REPAIR_PERMISSION.work))) {
    throw refuse('notTechnician', {
      code: 'VALIDATION_FAILED',
      details: { field: 'technicianId', issue: 'cannot do repair work in this store' },
      message: `user ${technicianId} cannot do repair work`,
    });
  }
};

/** Before photos come with a (re)start, after photos with marking the repair done. */
export const workPhotosAddedRule: Rule = async (op, { db }) => {
  const { stage } = payloadOf<Payload<typeof workPhotosAddedPayload>>(op);
  const ticket = await loadTicket(db, op);
  requireOutcome(ticket, op.type, PHOTO_STAGE_OUTCOMES[stage]);
};

/** Start, resume or reopen work: someone has taken the ticket, and a before photo exists. */
export const workStartedRule: Rule = async (op, { db }) => {
  const ticket = await loadTicket(db, op);
  requireOutcome(ticket, op.type, STARTABLE);
  if (ticket.technicianId === null) {
    throw invalidTransition(ticket, op.type, 'noTechnician', 'nobody has taken the ticket');
  }
  if (!(await hasWorkPhoto(db, op, 'before'))) {
    throw missingPhotos('before', `ticket ${ticket.ticketNumber} has no before photo yet`);
  }
};

export const workPausedRule: Rule = async (op, { db }) => {
  requireOutcome(await loadTicket(db, op), op.type, ['received', 'in_repair']);
};

/** Done, with at least one after photo taken since work last (re)started (owner decision). */
export const markedRepairedRule: Rule = async (op, { db }) => {
  const ticket = await loadTicket(db, op);
  requireOutcome(ticket, op.type, ['in_repair']);
  const startedAt = await lastStartedAt(db, op);
  if (!(await hasWorkPhoto(db, op, 'after', startedAt))) {
    throw missingPhotos(
      'after',
      `ticket ${ticket.ticketNumber} has no after photo for this repair`,
    );
  }
};

export const ticketCancelledRule: Rule = async (op, { db }) => {
  requireOpen(await loadTicket(db, op), op.type);
};

/** A technician's suggestion; one the cashier could never apply would only block handover. */
export const quoteChangeProposedRule: Rule = async (op, { db, holdsPermission }) => {
  const line = payloadOf<Payload<typeof quoteChangeProposedPayload>>(op);
  checkLineSign(line.kind, line.amount);
  await requireDiscountPermission(op, holdsPermission, [line.amount]);
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  checkTotal(ticket.quoteTotal, line.amount);
  await requireFreshLine(db, ticket, line.lineId, op.type);
};

/**
 * A price change by the cashier: a new line, or applying a technician's open proposal. Applying a
 * proposal is the customer agreeing to it; a new line waits exactly when the customer has not
 * agreed yet (v2; a v1 line has no `waitsForCustomer` and counted at once).
 */
export const quoteChangedRule: Rule = async (op, { db, holdsPermission }) => {
  const line = payloadOf<Payload<typeof quoteChangedPayload>>(op);
  checkLineSign(line.kind, line.amount);
  await requireDiscountPermission(op, holdsPermission, [line.amount]);
  const agreementMismatch = line.fromProposal
    ? !line.customerAgreed
    : op.schemaVersion >= 2 && line.waitsForCustomer !== !line.customerAgreed;
  if (agreementMismatch) {
    throw refuse('customerAgreementMismatch', {
      code: 'VALIDATION_FAILED',
      details: { field: 'customerAgreed', issue: 'does not match how the change counts' },
    });
  }
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  checkTotal(ticket.quoteTotal, line.amount);
  if (!line.fromProposal) {
    await requireFreshLine(db, ticket, line.lineId, op.type);
    return;
  }
  const proposal = await findLine(db, op, line.lineId);
  requireProposal(ticket, proposal, line.lineId, op.type);
  if (proposal!.kind !== line.kind) {
    throw invalidTransition(
      ticket,
      op.type,
      'priceChangeDifferent',
      `quote line ${line.lineId} is a ${proposal!.kind}`,
    );
  }
};

export const quoteProposalDeclinedRule: Rule = async (op, { db }) => {
  const { lineId } = payloadOf<Payload<typeof quoteProposalDeclinedPayload>>(op);
  const ticket = await loadTicket(db, op);
  requireProposal(ticket, await findLine(db, op, lineId), lineId, op.type);
};

/**
 * Hand the device back, once it is repaired or cancelled. On a repaired ticket open technician
 * proposals must be decided first, because they could change what the customer owes; on a
 * cancelled one they can no longer be decided, so they must not keep the phone in the store.
 */
export const deviceReturnedRule: Rule = async (op, { db, holdsPermission }) => {
  const ticket = await loadTicket(db, op);
  if (ticket.location === 'returned') {
    throw invalidTransition(ticket, op.type, 'returned', 'already returned');
  }
  if (ticket.outcome !== 'repaired' && ticket.outcome !== 'cancelled') {
    throw invalidTransition(ticket, op.type, 'notFinished', 'repair is not finished');
  }
  if (ticket.outcome === 'repaired' && (await pendingProposals(db, op)) > 0) {
    throw invalidTransition(
      ticket,
      op.type,
      'priceChangesPending',
      'price proposals are undecided',
    );
  }
  // Every version: an older payload carries no reason, so it hands over only a paid phone.
  await requirePaid(db, op, holdsPermission);
};

/**
 * The phone leaves only once the servisan is charged what it costs and nothing is left to pay,
 * unless an owner lets it go as a debt. The charge and payments are the ops just before this one
 * (`returnDeviceHandler`), and the server judges each on its own: a refused charge or payment
 * leaves a balance, so this is refused too.
 */
async function requirePaid(
  db: Parameters<Rule>[1]['db'],
  op: SignedOperation,
  holdsPermission: Parameters<Rule>[1]['holdsPermission'],
): Promise<void> {
  const unpaidReason =
    payloadOf<Partial<Payload<typeof deviceReturnedPayload>>>(op).unpaidReason ?? null;
  const lookup = { tenantId: op.tenantId, storeId: op.storeId ?? '', documentId: op.entityId };
  const ledger = db as unknown as Kysely<never>;
  const expected = await repairMoneyDocument.charge(ledger, lookup);
  const document = { kind: REPAIR_DOCUMENT_KIND, id: op.entityId };
  const charged = await documentTotal(ledger, lookup.storeId, document, 'charge_recorded');
  const owed = (expected?.amount ?? 0) > charged;
  const balance = await documentBalance(ledger, lookup.storeId, document);
  if (!owed && balance <= 0) return;
  if (unpaidReason === null) {
    throw refuse('notPaid', {
      code: 'VALIDATION_FAILED',
      details: { field: 'payments', issue: 'the servisan is not paid in full' },
    });
  }
  if (!(await holdsPermission(op.userId, MONEY_PERMISSION.extendCredit))) {
    throw refuse('unpaidOwnerOnly', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: MONEY_PERMISSION.extendCredit },
    });
  }
  // A debt is what the customer owes, so the full price is on the books first.
  if (owed) {
    throw refuse('notPaid', {
      code: 'VALIDATION_FAILED',
      details: { field: 'charge', issue: 'the servisan is not charged' },
    });
  }
}

/** One franchise list, written to the tenant's single options record and meeting the list rules. */
export const intakeOptionsChangedRule: Rule = (op) => {
  const { list, items } = payloadOf<z.output<typeof intakeOptionsChangedPayload>>(op);
  const problems = intakeListProblems(list, items);
  if (op.entityId !== op.tenantId || problems.length > 0) {
    return Promise.reject(
      refuse('invalidOptions', {
        code: 'VALIDATION_FAILED',
        details: { field: 'items', issue: problems.join(', ') || 'entity is not the tenant' },
      }),
    );
  }
  return Promise.resolve();
};

/** A store changes only its own settings: the record it writes is the op's own store. */
export const ownStoreSettingRule: Rule = (op) =>
  op.storeId !== null && op.entityId === op.storeId
    ? Promise.resolve()
    : Promise.reject(
        refuse('notThisStore', {
          code: 'PERMISSION_DENIED',
          details: { reason: 'restriction_violated', entityId: op.entityId },
        }),
      );

/**
 * A down payment taken at intake or later: once per ticket, while the servisan is open (in the
 * store and not cancelled), and no more than the price. Changing a recorded amount is an owner's correction, since a lower figure is
 * how cash would go missing.
 */
export const downPaymentReceivedRule: Rule = async (op, { db }) => {
  const { amount } = payloadOf<Payload<typeof downPaymentReceivedPayload>>(op);
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  const row = await db
    .selectFrom('repairTickets')
    .select('downPayment')
    .where('id', '=', ticket.id)
    .executeTakeFirst();
  if (row?.downPayment !== null && row?.downPayment !== undefined) {
    throw invalidTransition(ticket, op.type, 'downPaymentRecorded', 'a down payment is recorded');
  }
  checkDownPayment(amount, ticket.quoteTotal);
};

/** An owner's correction, at any time, of a ticket in this store. */
export const downPaymentCorrectedRule: Rule = async (op, { db }) => {
  await loadTicket(db, op);
};

/**
 * Any slip of a ticket in this store. The handover slip is the customer's bill and receipt, so it
 * exists only once the phone is ready to collect or gone.
 */
export const slipPrintedRule: Rule = async (op, { db }) => {
  const { slip } = payloadOf<Payload<typeof slipPrintedPayload>>(op);
  const ticket = await loadTicket(db, op);
  const ready =
    ticket.location === 'returned' ||
    ticket.outcome === 'repaired' ||
    ticket.outcome === 'cancelled';
  if (slip === 'handover' && !ready) {
    throw invalidTransition(ticket, op.type, 'notFinished', 'not ready to hand over');
  }
};
