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

import { approvedPermit } from '../approvals/permits.js';
import {
  REPAIR_APPROVAL_KIND,
  HANDOVER_UNDO_WINDOW_MS,
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
import {
  handoverProblem,
  intakeListProblems,
  needsOwnershipVideo,
  recordedOption,
  warrantyUntil,
  type RecordedRepairType,
} from './intake-options.js';
import { sameModelAnySpelling } from './device-models.js';
import { REPAIR_DOCUMENT_KIND, repairMoneyDocument } from './money-document.js';
import { cancelDrop, NO_CANCEL_FEES, standardCancelFee } from './queries.js';
import type {
  deviceReturnedPayload,
  downPaymentCorrectedPayload,
  downPaymentReceivedPayload,
  intakeOptionsChangedPayload,
  quoteChangedPayload,
  quoteChangeProposedPayload,
  quoteProposalDeclinedPayload,
  slipPrintedPayload,
  statusLinkMadePayload,
  technicianAssignedPayload,
  ticketDetailsCorrectedPayload,
  ticketOpenedPayload,
  workPhotosAddedPayload,
} from './operations.js';
import type { RepairDatabase } from './schema.js';
import { statusCodeFor } from './status-link.js';
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
  'repairTypesNotYours',
  'claimNotReturned',
  'claimOfClaim',
  'claimWithTypes',
  'warrantyEnded',
  'claimChargeOwnerOnly',
  'claimOtherPhone',
  'claimOtherImei',
  'partsNotInWork',
  'partsNotYours',
  'notPaid',
  'unpaidOwnerOnly',
  'downPaymentRefunded',
  'overLimit',
  'handoverAccessories',
  'handoverNoteNeeded',
  'statusLinkMismatch',
  'ownershipVideoNeeded',
  'freeHandoverOwnerOnly',
  'notReturned',
  'handoverHasClaim',
  'claimSamePhone',
  'nothingChanged',
  'undoTooLate',
  'handedOverBefore',
  'customerShared',
  'customerMismatch',
] as const);
type RepairRefusal = (typeof REPAIR_REFUSALS.reasons)[number];
const { refuse } = REPAIR_REFUSALS;

/**
 * A line that lowers the price is a discount, whatever its kind: only owners, and a limited role
 * such as a manager within its store's limit, may write one, so the counter cannot charge the
 * customer the full price and record less. A proposal counts too, so a discount never waits on the
 * board for someone who may not give it. A limit is per servisan: every discount still standing on
 * it (all but declined ones, the line being written aside) counts with this one.
 */
async function requireDiscountPermission(
  op: SignedOperation,
  ctx: Pick<Parameters<Rule>[1], 'db' | 'holdsPermission' | 'withinLimit'>,
  amounts: readonly number[],
  lineId?: string,
): Promise<void> {
  const drop = amounts.reduce((sum, amount) => (amount < 0 ? sum - amount : sum), 0);
  if (drop === 0) return;
  if (!(await ctx.holdsPermission(op.userId, REPAIR_PERMISSION.discount))) {
    throw refuse('discountOwnerOnly', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: REPAIR_PERMISSION.discount },
      message: `user ${op.userId} cannot lower a price`,
    });
  }
  const earlier = lineId === undefined ? 0 : await discountsStanding(ctx.db, op, lineId);
  await requireWithinLimit(op, ctx, REPAIR_PERMISSION.discount, earlier + drop);
}

/**
 * What the discounts still standing on the op's ticket take off, besides line `exceptLineId`: the
 * price drops already on the servisan, which its limit counts together with a new one (a discount,
 * or a cancel fee below the store's).
 */
async function discountsStanding(db: Db, op: TicketRef, exceptLineId?: string) {
  let query = db
    .selectFrom('repairQuoteLines')
    .select(sql<number>`coalesce(sum(-amount), 0)`.as('drop'))
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeOf(op))
    .where('amount', '<', 0)
    .where('status', '!=', 'declined');
  if (exceptLineId !== undefined) query = query.where('id', '!=', exceptLineId);
  const row = await query.executeTakeFirst();
  return Number(row?.drop ?? 0);
}

/**
 * A limited role (a manager) uses an owner's decision only as far as its store's limit goes
 * (core authz/limits.ts); owners have no limit. The author holds `permissionId` already: the op
 * type's permission, or a check just made.
 */
async function requireWithinLimit(
  op: SignedOperation,
  ctx: Pick<Parameters<Rule>[1], 'withinLimit'>,
  permissionId: string,
  amount: number,
): Promise<void> {
  if (await ctx.withinLimit(op.userId, permissionId, amount)) return;
  throw refuse('overLimit', {
    code: 'PERMISSION_DENIED',
    details: { permissionId, issue: `above the limit for ${amount}` },
    message: `user ${op.userId} may not use ${permissionId} for ${amount}`,
  });
}

/**
 * A warranty claim is free unless an owner says otherwise, at intake and after: a price change that
 * adds to one needs an owner. A technician may still propose it; applying it is the owner's.
 */
async function requireClaimChargePermission(
  op: SignedOperation,
  holdsPermission: Parameters<Rule>[1]['holdsPermission'],
  ticket: TicketState,
  amount: number,
): Promise<void> {
  if (ticket.claimOfTicketId === null || amount <= 0) return;
  if (await holdsPermission(op.userId, REPAIR_PERMISSION.warrantyException)) return;
  throw refuse('claimChargeOwnerOnly', {
    code: 'PERMISSION_DENIED',
    details: { permissionId: REPAIR_PERMISSION.warrantyException },
    message: `user ${op.userId} cannot charge for warranty claim ${ticket.ticketNumber}`,
  });
}

// ── shared checks (also used by the commands to word their own input errors) ─────────────────────

/**
 * A repaired servisan that costs nothing and is not a warranty claim goes home only with an owner,
 * so a free repair is never the counter's call. A Rp 0 intake ("cek dulu") stays open to everyone.
 */
export function freeHandoverNeedsOwner(
  ticket: Pick<TicketState, 'outcome' | 'quoteTotal' | 'claimOfTicketId'>,
): boolean {
  return (
    ticket.outcome === 'repaired' && ticket.claimOfTicketId === null && ticket.quoteTotal === 0
  );
}

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
  readonly cancelFee: number | null;
  /** The servisan this one is a warranty claim on; null for an ordinary one. */
  readonly claimOfTicketId: string | null;
  /** When it was first handed over; kept when a handover is taken back. */
  readonly returnedAt: number | null;
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

async function findTicket(db: Db, op: TicketRef): Promise<TicketState | undefined> {
  const row = await db
    .selectFrom('repairTickets')
    .select([
      'id',
      'ticketNumber',
      'outcome',
      'location',
      'technicianId',
      'quoteTotal',
      'cancelFee',
      'claimOfTicketId',
      'returnedAt',
    ])
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
    cancelFee: row.cancelFee === null ? null : Number(row.cancelFee),
    claimOfTicketId: row.claimOfTicketId,
    returnedAt: row.returnedAt === null ? null : Number(row.returnedAt),
  };
}

async function loadTicket(db: Db, op: TicketRef): Promise<TicketState> {
  const ticket = await findTicket(db, op);
  if (ticket === undefined) throw notFound(REPAIR_TICKET_ENTITY, op.entityId);
  return ticket;
}

/** Repair ops are store-scoped, so a null store never matches a row. */
function storeOf(op: { readonly storeId: string | null }): string {
  return op.storeId ?? '';
}

/** A servisan as rules find it: the op's, or the one an approval request is about. */
type TicketRef = Pick<SignedOperation, 'tenantId' | 'storeId' | 'entityId'>;

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
async function lastStartedAt(db: Db, op: TicketRef): Promise<number> {
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

/**
 * A customer's details are corrected while one of their servisans is still in the store, like the
 * servisan's own details: once everything went home, the slips they signed are the record.
 */
export const customerDetailsCorrectedRule: Rule = async (op, { db }) => {
  if (!(await customerExists(db, op, op.entityId))) {
    throw notFound(REPAIR_CUSTOMER_ENTITY, op.entityId);
  }
  await requireRenamable(db, op, op.entityId);
};

/**
 * A customer's own record is renamed only while it names one servisan, still in the store, and
 * never handed over: a rename would otherwise rewrite who a signed slip or a debt belongs to. A
 * servisan opened elsewhere while offline counts too, once it syncs.
 */
async function requireRenamable(db: Db, op: SignedOperation, customerId: string): Promise<void> {
  const tickets = await db
    .selectFrom('repairTickets')
    .select(['location', 'returnedAt'])
    .where('customerId', '=', customerId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .execute();
  if (tickets.length > 1) {
    throw refuse('customerShared', {
      code: 'INVALID_TRANSITION',
      details: { entityType: REPAIR_CUSTOMER_ENTITY, entityId: customerId },
      message: 'the customer has more than one servisan',
    });
  }
  if (tickets.some((ticket) => ticket.location === 'returned' || ticket.returnedAt !== null)) {
    throw refuse('returned', {
      code: 'INVALID_TRANSITION',
      details: { entityType: REPAIR_CUSTOMER_ENTITY, entityId: op.entityId },
      message: 'a servisan of this customer was handed over',
    });
  }
}

/**
 * The repair types of an open servisan, set after the diagnosis: by the counter, who took it in, or
 * a technician, who found what is wrong. Not once the phone left or the servisan was cancelled,
 * since the warranty the customer took home must not change, and never on a warranty claim.
 */
export const ticketRepairTypesChangedRule: Rule = async (op, { db, holdsPermission }) => {
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  // A claim's types and warranty are its servisan's, so it never gets its own.
  if (ticket.claimOfTicketId !== null) {
    throw refuse('claimWithTypes', {
      code: 'VALIDATION_FAILED',
      details: { field: 'repairTypes', issue: 'a claim with repair types' },
    });
  }
  if (
    (await holdsPermission(op.userId, REPAIR_PERMISSION.intake)) ||
    (await holdsPermission(op.userId, REPAIR_PERMISSION.work))
  ) {
    return;
  }
  throw refuse('repairTypesNotYours', {
    code: 'PERMISSION_DENIED',
    details: { permissionId: REPAIR_PERMISSION.work },
    message: `user ${op.userId} neither takes in nor works on phones`,
  });
};

/** The servisan a claim names, as far as the claim rule needs it. */
export interface ClaimedServisan {
  readonly outcome: string;
  readonly location: string;
  readonly returnedAt: number | null;
  readonly repairTypes: readonly RecordedRepairType[];
  readonly claimOfTicketId: string | null;
  readonly customerId: string;
  readonly deviceImei: string | null;
  readonly deviceBrand: string;
  readonly deviceModel: string;
}

/** What a new claim brings: who and which phone, what it picks, and what it costs. */
export interface ClaimRequest {
  readonly customerId: string;
  readonly imei: string | null;
  readonly brand: string;
  readonly model: string;
  readonly repairTypes: readonly unknown[];
  readonly total: number;
  /** When it was signed. */
  readonly at: number;
}

/**
 * A warranty claim: a new servisan for a phone that went home repaired. It names the servisan it
 * claims on, never another claim, so the warranty always counts from that first pickup and a
 * claim cannot stretch it. It carries no repair types of its own: it repairs what that servisan
 * did. Free while the warranty runs; a claim after it ended, or one the customer pays for, needs an
 * owner (owner decision).
 *
 * Returns why this claim cannot be opened, or null when it can: `owner` reasons fall away for
 * someone holding the warranty exception. Shared by the rule and the demo runtime so they judge
 * alike.
 */
export function claimProblem(
  original: ClaimedServisan,
  claim: ClaimRequest,
): { readonly reason: RepairRefusal; readonly owner: boolean } | null {
  if (original.location !== 'returned' || original.outcome !== 'repaired') {
    return { reason: 'claimNotReturned', owner: false };
  }
  if (original.claimOfTicketId !== null) return { reason: 'claimOfClaim', owner: false };
  if (claim.repairTypes.length > 0) return { reason: 'claimWithTypes', owner: false };
  // The warranty covers that customer's phone, not another one brought in under its number.
  const imei = (value: string | null): string => (value ?? '').trim();
  if (claim.customerId !== original.customerId) return { reason: 'claimOtherPhone', owner: false };
  if (
    imei(claim.imei) !== '' &&
    imei(original.deviceImei) !== '' &&
    imei(claim.imei) !== imei(original.deviceImei)
  ) {
    return { reason: 'claimOtherImei', owner: false };
  }
  // Nor another model: a phone with no IMEI written down is still the brand and model it was.
  if (
    !sameModelAnySpelling(
      { brand: original.deviceBrand, model: original.deviceModel },
      { brand: claim.brand, model: claim.model },
    )
  ) {
    return { reason: 'claimOtherPhone', owner: false };
  }
  if (claim.total > 0) return { reason: 'claimChargeOwnerOnly', owner: true };
  const until = warrantyUntil(original.repairTypes, original.returnedAt);
  // Signed between pickup and the warranty's end: a phone clock set back before pickup proves
  // nothing about when the claim was made.
  const covered =
    until !== null &&
    original.returnedAt !== null &&
    claim.at >= original.returnedAt &&
    claim.at <= until;
  return covered ? null : { reason: 'warrantyEnded', owner: true };
}

async function requireClaimable(
  db: Db,
  op: SignedOperation,
  claimOf: string,
  claim: Omit<ClaimRequest, 'at'>,
  holdsPermission: Parameters<Rule>[1]['holdsPermission'],
): Promise<void> {
  const original = await db
    .selectFrom('repairTickets')
    .select([
      'outcome',
      'location',
      'returnedAt',
      'repairTypesJson',
      'claimOfTicketId',
      'customerId',
      'deviceImei',
      'deviceBrand',
      'deviceModel',
    ])
    .where('id', '=', claimOf)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  if (original === undefined) throw notFound(REPAIR_TICKET_ENTITY, claimOf);
  const problem = claimProblem(
    {
      ...original,
      returnedAt: original.returnedAt === null ? null : Number(original.returnedAt),
      repairTypes: JSON.parse(original.repairTypesJson) as RecordedRepairType[],
    },
    { ...claim, at: op.timestamp },
  );
  if (problem === null) return;
  if (!problem.owner) {
    throw refuse(problem.reason, {
      code: 'VALIDATION_FAILED',
      details: { field: 'claimOf', issue: problem.reason },
    });
  }
  if (await holdsPermission(op.userId, REPAIR_PERMISSION.warrantyException)) return;
  throw refuse(problem.reason, {
    code: 'PERMISSION_DENIED',
    details: { permissionId: REPAIR_PERMISSION.warrantyException },
    message: `user ${op.userId} cannot open this claim on ticket ${claimOf}`,
  });
}

/**
 * A new ticket: a fresh id, a customer of this store, a price that adds up, and a ticket number
 * this device minted (its own code, or an earlier registration's it carried changes over from) and
 * has not used before. The number is printed for the customer, so it is the device's to mint offline
 * but never another device's to reuse.
 */
export const ticketOpenedRule: Rule = async (op, ctx) => {
  const { db, holdsPermission } = ctx;
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
    ctx,
    payload.quoteLines.map((line) => line.amount),
  );
  const total = payload.quoteLines.reduce((sum, line) => sum + line.amount, 0);
  checkTotal(0, total);
  // From v4 the customer's ownership video comes with the intake that needs one.
  if (
    op.schemaVersion >= 4 &&
    payload.ownershipVideo === null &&
    needsOwnershipVideo(payload.repairTypes)
  ) {
    throw ownershipVideoNeeded();
  }
  // v1 and v2 intakes were signed before claims.
  const claimOf = (payload as { claimOf?: string | null }).claimOf ?? null;
  if (claimOf !== null) {
    await requireClaimable(
      db,
      op,
      claimOf,
      {
        customerId: payload.customerId,
        imei: payload.device.imei,
        brand: payload.device.brand,
        model: payload.device.model,
        repairTypes: payload.repairTypes,
        total,
      },
      holdsPermission,
    );
  }
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

/**
 * Cancel an open ticket. A fee below the store's standard fee is a price drop: an owner's to give,
 * and a limited role's (a manager's) within its store's limit, together with the servisan's
 * discounts. The standard fee is the store's as these records have it, not the payload's, which the
 * device writing it could set to anything.
 */
export const ticketCancelledRule: Rule = async (op, ctx) => {
  const ticket = await loadTicket(ctx.db, op);
  requireOpen(ticket, op.type);
  // A handover taken back was charged and paid for: it goes home again, it is not cancelled.
  if (ticket.returnedAt !== null) {
    throw invalidTransition(ticket, op.type, 'handedOverBefore', 'it was handed over before');
  }
  // v1, from before fees, names no fee and charges nothing (the applier records no fee): a drop
  // of the whole standard fee, which an older phone must not get past the limit with.
  const fee = payloadOf<{ fee?: number }>(op).fee ?? 0;
  const standard = await standardFeeOf(ctx.db, op, ticket);
  const counted = cancelDrop(standard, fee, await discountsStanding(ctx.db, op));
  await requireWithinLimit(op, ctx, REPAIR_PERMISSION.cancel, counted);
};

/** The store's cancellation fee for this ticket as these records have it now. */
async function standardFeeOf(db: Db, ref: TicketRef, ticket: TicketState): Promise<number> {
  const fees = await db
    .selectFrom('repairStoreCancelFees')
    .select(['beforeWork', 'afterWork'])
    .where('storeId', '=', storeOf(ref))
    .executeTakeFirst();
  return standardCancelFee(
    { workStarted: (await lastStartedAt(db, ref)) > 0, claimOfTicketId: ticket.claimOfTicketId },
    fees === undefined
      ? NO_CANCEL_FEES
      : { beforeWork: Number(fees.beforeWork), afterWork: Number(fees.afterWork) },
  );
}

/**
 * What an approval request about a servisan depends on (approvals/kinds.ts): where it is, how it
 * stands and its price. Null when this store has no such servisan.
 */
export async function ticketApprovalBasis(db: Db, ref: TicketRef): Promise<string | null> {
  const ticket = await findTicket(db, ref);
  if (ticket === undefined) return null;
  // Lines are only ever added, so a price that comes back to the same total still moves the basis.
  const lines = await db
    .selectFrom('repairQuoteLines')
    .select(sql<number>`count(*)`.as('count'))
    .where('ticketId', '=', ref.entityId)
    .where('storeId', '=', storeOf(ref))
    .executeTakeFirst();
  return [ticket.outcome, ticket.location, ticket.quoteTotal, Number(lines?.count ?? 0)].join('|');
}

/** What the discounts standing on a servisan take off (all but declined ones). */
export async function ticketDiscounts(db: Db, ref: TicketRef): Promise<number> {
  return discountsStanding(db, ref);
}

/** The fee a cancel of this open servisan is held to now, or null when it cannot be cancelled. */
export async function cancelStandardFee(db: Db, ref: TicketRef): Promise<number | null> {
  const ticket = await findTicket(db, ref);
  if (ticket === undefined || ticket.location === 'returned' || ticket.outcome === 'cancelled') {
    return null;
  }
  return standardFeeOf(db, ref, ticket);
}

/** A technician's suggestion; one the cashier could never apply would only block handover. */
export const quoteChangeProposedRule: Rule = async (op, ctx) => {
  const { db } = ctx;
  const line = payloadOf<Payload<typeof quoteChangeProposedPayload>>(op);
  checkLineSign(line.kind, line.amount);
  await requireDiscountPermission(op, ctx, [line.amount], line.lineId);
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  checkTotal(ticket.quoteTotal, line.amount);
  await requireFreshLine(db, ticket, line.lineId, op.type);
};

/**
 * A price change by the cashier: a new line, or applying a technician's open proposal. Applying a
 * proposal is the customer agreeing to it; a new line waits exactly when the customer has not
 * agreed yet. A v1 line has no `waitsForCustomer` and counts at once, so it needs the customer's
 * yes too (synced v1 history replays through the applier, which no rule judges).
 */
export const quoteChangedRule: Rule = async (op, ctx) => {
  const { db, holdsPermission } = ctx;
  const line = payloadOf<Payload<typeof quoteChangedPayload>>(op);
  checkLineSign(line.kind, line.amount);
  await requireDiscountPermission(op, ctx, [line.amount], line.lineId);
  const waits = op.schemaVersion >= 2 && line.waitsForCustomer;
  const agreementMismatch = line.fromProposal
    ? !line.customerAgreed
    : waits !== !line.customerAgreed;
  if (agreementMismatch) {
    throw refuse('customerAgreementMismatch', {
      code: 'VALIDATION_FAILED',
      details: { field: 'customerAgreed', issue: 'does not match how the change counts' },
    });
  }
  const ticket = await loadTicket(db, op);
  requireOpen(ticket, op.type);
  checkTotal(ticket.quoteTotal, line.amount);
  await requireClaimChargePermission(op, holdsPermission, ticket, line.amount);
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
export const deviceReturnedRule: Rule = async (op, ctx) => {
  const { db } = ctx;
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
  if (
    freeHandoverNeedsOwner(ticket) &&
    !(await ctx.holdsPermission(op.userId, REPAIR_PERMISSION.warrantyException))
  ) {
    throw refuse('freeHandoverOwnerOnly', {
      code: 'PERMISSION_DENIED',
      details: { permissionId: REPAIR_PERMISSION.warrantyException },
      message: `user ${op.userId} cannot hand over ticket ${ticket.ticketNumber} for free`,
    });
  }
  // Every version: an older payload carries no reason, so it hands over only a paid phone.
  await requirePaid(op, ctx);
  // Before v3 there was no checklist to judge.
  if (op.schemaVersion >= 3) await requireHandoverChecks(db, op);
};

/**
 * Taking a handover back (owner decision): only one that happened, and not once a warranty claim
 * was opened on it, since that claim already counts from this pickup.
 */
export const handoverReversedRule: Rule = async (op, ctx) => {
  const { db } = ctx;
  const ticket = await loadTicket(db, op);
  if (ticket.location !== 'returned') {
    throw invalidTransition(ticket, op.type, 'notReturned', 'the phone has not been handed over');
  }
  // Counted from the first handover, so taking it back again and again never stretches it.
  if (ticket.returnedAt === null || op.timestamp - ticket.returnedAt > HANDOVER_UNDO_WINDOW_MS) {
    throw invalidTransition(ticket, op.type, 'undoTooLate', 'the handover was too long ago');
  }
  // What went home is at stake: a limited role (a manager) only within its cancel limit.
  const owed = ticket.outcome === 'cancelled' ? (ticket.cancelFee ?? 0) : ticket.quoteTotal;
  await requireWithinLimit(op, ctx, REPAIR_PERMISSION.cancel, owed);
  const claim = await db
    .selectFrom('repairTickets')
    .select('id')
    .where('claimOfTicketId', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  if (claim !== undefined) {
    throw invalidTransition(ticket, op.type, 'handoverHasClaim', 'a warranty claim names it');
  }
};

/**
 * Intake's record is corrected only while the phone is in the store: after pickup the slip the
 * customer signed is the record. A claim is for the phone its servisan repaired, so its brand,
 * model and IMEI stay as they are. A correction says what changed; moving the servisan to another
 * customer is a correction too, and like the rest it ends at pickup.
 */
export const ticketDetailsCorrectedRule: Rule = async (op, { db }) => {
  const ticket = await loadTicket(db, op);
  if (ticket.location === 'returned') {
    throw invalidTransition(ticket, op.type, 'returned', 'the device has already been returned');
  }
  const payload = payloadOf<Payload<typeof ticketDetailsCorrectedPayload>>(op);
  if (Object.keys(payload).every((field) => field === 'reason')) {
    throw refuse('nothingChanged', {
      code: 'VALIDATION_FAILED',
      details: { field: 'device', issue: 'nothing to correct' },
    });
  }
  // After a handover (since taken back) the slip the customer signed names them and that phone.
  const handedOver = ticket.returnedAt !== null;
  if (handedOver && (payload.customer !== undefined || payload.customerId !== undefined)) {
    throw invalidTransition(ticket, op.type, 'handedOverBefore', 'it was handed over before');
  }
  if (payload.customerId !== undefined) {
    // The history's "now" must be the customer the servisan moves to.
    const target = await db
      .selectFrom('repairCustomers')
      .select(['name', 'phone'])
      .where('id', '=', payload.customerId)
      .where('tenantId', '=', op.tenantId)
      .where('storeId', '=', storeOf(op))
      .executeTakeFirst();
    if (target === undefined) throw notFound(REPAIR_CUSTOMER_ENTITY, payload.customerId);
    if (
      payload.customer === undefined ||
      payload.customer.name !== target.name ||
      payload.customer.phone !== target.phone
    ) {
      throw refuse('customerMismatch', {
        code: 'VALIDATION_FAILED',
        details: { field: 'customer', issue: 'not the customer it moves to' },
      });
    }
  } else if (payload.customer !== undefined) {
    // Without a move the servisan's customer is renamed in place, under the same rule as a rename.
    const row = await db
      .selectFrom('repairTickets')
      .select('customerId')
      .where('id', '=', op.entityId)
      .where('tenantId', '=', op.tenantId)
      .where('storeId', '=', storeOf(op))
      .executeTakeFirstOrThrow();
    await requireRenamable(db, op, row.customerId);
  }
  const lockedPhone = ticket.claimOfTicketId !== null || handedOver;
  if (lockedPhone && payload.device !== undefined) {
    const row = await db
      .selectFrom('repairTickets')
      .select(['deviceBrand', 'deviceModel', 'deviceImei'])
      .where('id', '=', op.entityId)
      .where('tenantId', '=', op.tenantId)
      .where('storeId', '=', storeOf(op))
      .executeTakeFirstOrThrow();
    if (
      row.deviceBrand !== payload.device.brand ||
      row.deviceModel !== payload.device.model ||
      row.deviceImei !== payload.device.imei
    ) {
      throw refuse(handedOver ? 'handedOverBefore' : 'claimSamePhone', {
        code: 'VALIDATION_FAILED',
        details: { field: 'device', issue: 'the phone is the one on the signed slip' },
      });
    }
  }
};

function ownershipVideoNeeded(): DomainError {
  return refuse('ownershipVideoNeeded', {
    code: 'VALIDATION_FAILED',
    details: { field: 'ownershipVideo', issue: 'a repair type needs the ownership video' },
  });
}

/** Every accessory left at intake is on the checklist, and whatever is not ticked has a note. */
async function requireHandoverChecks(db: Db, op: SignedOperation): Promise<void> {
  const { checklist, note } = payloadOf<Payload<typeof deviceReturnedPayload>>(op);
  const row = await db
    .selectFrom('repairTickets')
    .select('peripheralsJson')
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirstOrThrow();
  const accessories = (JSON.parse(row.peripheralsJson) as unknown[]).map(recordedOption);
  const problem = handoverProblem(checklist, accessories, note);
  if (problem !== null) {
    throw refuse(problem, {
      code: 'VALIDATION_FAILED',
      details: { field: problem === 'handoverAccessories' ? 'checklist' : 'note' },
    });
  }
}

/**
 * The phone leaves only once the servisan is charged what it costs and nothing is left to pay,
 * unless an owner lets it go as a debt. The charge and payments are the ops just before this one
 * (`returnDeviceHandler`), and the server judges each on its own: a refused charge or payment
 * leaves a balance, so this is refused too.
 */
async function requirePaid(op: SignedOperation, ctx: Parameters<Rule>[1]): Promise<void> {
  const unpaidReason =
    payloadOf<Partial<Payload<typeof deviceReturnedPayload>>>(op).unpaidReason ?? null;
  const { owed, balance } = await ticketLedger(ctx.db, op);
  if (!owed && balance <= 0) return;
  if (unpaidReason === null) {
    throw refuse('notPaid', {
      code: 'VALIDATION_FAILED',
      details: { field: 'payments', issue: 'the servisan is not paid in full' },
    });
  }
  // An owner's approved "Bayar nanti" lets anyone at the counter leave a debt up to its amount.
  const permit = await approvedPermit(ctx.db as unknown as Kysely<never>, {
    tenantId: op.tenantId,
    storeId: storeOf(op),
    kind: REPAIR_APPROVAL_KIND.payLater,
    targetId: op.entityId,
  });
  const permitted = permit !== null && permit >= balance;
  if (!permitted && !(await ctx.holdsPermission(op.userId, MONEY_PERMISSION.extendCredit))) {
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
  if (permitted) return;
  // A limited role (a manager) lets a phone go only for a debt within its store's limit.
  await requireWithinLimit(op, ctx, MONEY_PERMISSION.extendCredit, balance);
}

/** Whether the servisan is charged less than it costs, and what is left to pay on what it is. */
async function ticketLedger(db: Db, ref: TicketRef) {
  const lookup = { tenantId: ref.tenantId, storeId: storeOf(ref), documentId: ref.entityId };
  const ledger = db as unknown as Kysely<never>;
  const expected = await repairMoneyDocument.charge(ledger, lookup);
  const document = { kind: REPAIR_DOCUMENT_KIND, id: ref.entityId };
  const charged = await documentTotal(ledger, lookup.storeId, document, 'charge_recorded');
  const balance = await documentBalance(ledger, lookup.storeId, document);
  return {
    expected: expected?.amount ?? 0,
    charged,
    owed: (expected?.amount ?? 0) > charged,
    balance,
  };
}

/**
 * What the customer would owe if the phone left now unpaid: its price or fee, less what they paid.
 * Null unless it is ready to collect (repaired or cancelled, still in the store).
 */
export async function handoverDebt(db: Db, ref: TicketRef): Promise<number | null> {
  const ticket = await findTicket(db, ref);
  if (
    ticket === undefined ||
    ticket.location !== 'in_store' ||
    (ticket.outcome !== 'repaired' && ticket.outcome !== 'cancelled')
  ) {
    return null;
  }
  const { expected, charged, balance } = await ticketLedger(db, ref);
  return Math.max(0, Math.max(0, expected - charged) + balance);
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

/**
 * An owner's correction, at any time, of a ticket in this store (older devices; newer ones void
 * and re-record the payment in the ledger, which the refund limit counts). Lowering it is an
 * owner's alone: nothing counts it with the servisan's other price drops, and no phone that knows
 * limited roles (managers) writes it, so no limit covers it.
 */
export const downPaymentCorrectedRule: Rule = async (op, ctx) => {
  const ticket = await loadTicket(ctx.db, op);
  const { amount } = payloadOf<Payload<typeof downPaymentCorrectedPayload>>(op);
  const row = await ctx.db
    .selectFrom('repairTickets')
    .select('downPayment')
    .where('id', '=', ticket.id)
    .executeTakeFirst();
  const drop = Number(row?.downPayment ?? 0) - amount;
  const judged = drop > 0 ? Number.MAX_SAFE_INTEGER : drop;
  await requireWithinLimit(op, ctx, REPAIR_PERMISSION.correctDownPayment, judged);
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

/**
 * One status link per servisan, made with it: a second would leave a printed link dead. Its code
 * must be the one its nonce gives this servisan, so a code copied off another store's slip is
 * refused.
 */
export const statusLinkMadeRule: Rule = async (op, { db, sha256 }) => {
  const { code, nonce } = payloadOf<z.infer<typeof statusLinkMadePayload>>(op);
  const owner = { tenantId: op.tenantId, storeId: storeOf(op), ticketId: op.entityId };
  if (code !== statusCodeFor(owner, nonce, sha256)) {
    throw refuse('statusLinkMismatch', {
      code: 'VALIDATION_FAILED',
      details: { field: 'code', issue: 'does not match its nonce' },
      message: `status link of ${op.entityId} does not match its nonce`,
    });
  }
  await loadTicket(db, op);
  const row = await db
    .selectFrom('repairTickets')
    .select('statusCode')
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .where('storeId', '=', storeOf(op))
    .executeTakeFirst();
  if ((row?.statusCode ?? null) !== null) {
    throw alreadyRecorded('statusLink', op.entityId);
  }
};
