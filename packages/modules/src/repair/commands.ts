// The `repair` commands: the only write path. Handlers are pure; they read through `ctx.query`
// and compose op drafts. Whether each op may be recorded is its type's rule (rules.ts), which the
// runtime runs on every op before saving and the server runs again on push, so the handlers do not
// repeat those checks. The appliers stay total so concurrent offline work still folds.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';
import { zMediaRef, zVideoRef, type MediaRef } from '@bolusi/schemas';

import {
  MAX_LINE_AMOUNT,
  MAX_UNCOLLECTED_DAYS,
  MIN_UNCOLLECTED_DAYS,
  QUOTE_LINE_KINDS,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_INTAKE_OPTIONS_ENTITY,
  REPAIR_OP,
  REPAIR_STORE_CANCEL_FEES_ENTITY,
  REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  REPAIR_STORE_PRINT_SETTINGS_ENTITY,
  REPAIR_STORE_UNCOLLECTED_ENTITY,
  REPAIR_TICKET_ENTITY,
  SLIP_KINDS,
  WORK_PHOTOS_MAX,
  type WorkPhotoStage,
} from './constants.js';
import { findDeviceModelQuery } from './device-models.js';
import {
  INTAKE_OPTION_LISTS,
  MAX_OPTIONS,
  NON_EMPTY_LISTS,
  intakeListProblems,
  recordRepairTypes,
  sameOptions,
  sameRepairTypes,
  storeIntakeOptions,
  type IntakeOption,
  type IntakeOptionList,
  type IntakeOptionSettings,
  type RecordedRepairType,
} from './intake-options.js';
import {
  MAX_TERMS,
  MAX_TICKET_REPAIR_TYPES,
  zChecklistItemV2,
  zHandoverCheck,
  zDevice,
  zIntakePhotosV2,
  zOptionId,
  zRecordedOption,
} from './operations.js';
import {
  cancelFeesQuery,
  getCustomerQuery,
  getTicketQuery,
  intakeOptionSettingsQuery,
  nextTicketCounterQuery,
  printSettingsQuery,
  standardCancelFee,
  uncollectedDaysQuery,
  type CancelFees,
  type PrintSettings,
  type TicketDetailRow,
} from './queries.js';
import { CASH_ACCOUNT, HANDOVER_REFUND_REASON } from '../money/constants.js';
import {
  chargeOp,
  paymentOp,
  refundOp,
  voidOp,
  zPaymentInput,
  zReference,
} from '../money/commands.js';
import { zAccountRef } from '../money/operations.js';
import { documentMoneyQuery, type DocumentMoney } from '../money/queries.js';
import { refundSplit } from '../money/rules.js';
import { REPAIR_DOCUMENT_KIND, ticketCharge } from './money-document.js';
import { REPAIR_REFUSALS, checkDownPayment, requireProposal } from './rules.js';
import { formatTicketNumber } from './ticket-number.js';

type OpDraft = ReturnType<CommandContext['op']>;

const zText = (max: number) => z.string().trim().max(max);
const zRequiredText = (max: number) => z.string().trim().min(1).max(max);
const zPhone = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .transform((phone) => (phone === null || phone === '' ? null : phone));
const zAmountInput = z.number().int().min(-MAX_LINE_AMOUNT).max(MAX_LINE_AMOUNT);

const zLineInput = z
  .object({
    kind: z.enum(QUOTE_LINE_KINDS),
    description: zRequiredText(200),
    amount: zAmountInput,
  })
  .strict();

async function loadTicket(ctx: CommandContext, ticketId: string): Promise<TicketDetailRow> {
  const page = await ctx.query(getTicketQuery, { ticketId });
  const ticket = page.rows[0];
  if (ticket === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: REPAIR_TICKET_ENTITY,
      entityId: ticketId,
    });
  }
  return ticket;
}

function ticketOp(ctx: CommandContext, ticketId: string, type: string, payload: object) {
  return ctx.op({
    type,
    entityType: REPAIR_TICKET_ENTITY,
    entityId: ticketId,
    payload: payload as Record<string, unknown>,
  });
}

/** A servisan as the money ledger names it. */
function ticketDocument(ticketId: string, ticketNumber: string) {
  return { kind: REPAIR_DOCUMENT_KIND, id: ticketId, label: ticketNumber };
}

async function ticketMoney(ctx: CommandContext, ticketId: string): Promise<DocumentMoney> {
  return (await ctx.query(documentMoneyQuery, { kind: REPAIR_DOCUMENT_KIND, id: ticketId }))
    .rows[0]!;
}

// ── customers ──────────────────────────────────────────────────────────────────────────────────

export const registerCustomerInput = z
  .object({ name: zRequiredText(200), phone: zPhone.default(null) })
  .strict();
export type RegisterCustomerInput = z.input<typeof registerCustomerInput>;

export function registerCustomerHandler(
  input: z.output<typeof registerCustomerInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ customerId: string }> {
  const customerId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.customerRegistered,
        entityType: REPAIR_CUSTOMER_ENTITY,
        entityId: customerId,
        payload: { name: input.name, phone: input.phone },
      }),
    ],
    result: { customerId },
  };
}

export const correctCustomerDetailsInput = z
  .object({ customerId: z.string().min(1), name: zRequiredText(200), phone: zPhone })
  .strict();
export type CorrectCustomerDetailsInput = z.input<typeof correctCustomerDetailsInput>;

export async function correctCustomerDetailsHandler(
  input: z.output<typeof correctCustomerDetailsInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ customerId: string }>> {
  const customer = (await ctx.query(getCustomerQuery, { customerId: input.customerId })).rows[0]!;
  if (customer.name === input.name && customer.phone === input.phone) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'name', issue: 'nothing changed' },
      'the corrected details are identical to the current ones',
    );
  }
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.customerDetailsCorrected,
        entityType: REPAIR_CUSTOMER_ENTITY,
        entityId: input.customerId,
        payload: { name: input.name, phone: input.phone },
      }),
    ],
    result: { customerId: input.customerId },
  };
}

/** Repair types picked by id, each once. */
const zRepairTypeIds = z
  .array(zOptionId)
  .max(MAX_TICKET_REPAIR_TYPES)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'a repair type is picked twice' });

// ── openTicket (the one-sitting intake) ────────────────────────────────────────────────────────

export const openTicketInput = z
  .object({
    /**
     * The id the intake took when it started. Opening the same id again returns the ticket that
     * already exists, so a draft restored after the app died mid-submit cannot open it twice.
     */
    ticketId: z.string().min(1).optional(),
    /** An existing customer, or a new one registered in the same command. */
    customer: z.union([
      z.object({ customerId: z.string().min(1) }).strict(),
      z.object({ name: zRequiredText(200), phone: zPhone.default(null) }).strict(),
    ]),
    device: zDevice.extend({
      brand: zRequiredText(100),
      model: zRequiredText(100),
      color: zText(200).default(''),
      imei: zPhone.default(null),
      passcode: z
        .string()
        .max(200)
        .nullable()
        .default(null)
        .transform((value) => (value === '' ? null : value)),
    }),
    complaint: zRequiredText(2000),
    intakeNotes: zText(2000).default(''),
    checklist: z.array(zChecklistItemV2).max(100).default([]),
    peripherals: z.array(zRecordedOption).max(50).default([]),
    /** What is being repaired, by the ids on this store's list; the terms are recorded here. */
    repairTypes: zRepairTypeIds.default([]),
    /**
     * The servisan this intake is a warranty claim on: one that went home repaired. A claim repairs
     * what that one did, so it picks no repair types of its own.
     */
    claimOf: z.string().min(1).nullable().default(null),
    estimatedReadyAt: z.number().int().nullable().default(null),
    quoteLines: z.array(zLineInput).min(1).max(100),
    /** One photo per angle the store asks for, labelled as the counter saw it. */
    photos: zIntakePhotosV2,
    /** The customer saying the phone is theirs, when a picked repair type asks for it. */
    ownershipVideo: zVideoRef.nullable().default(null),
    /** Integer IDR the customer paid up front; 0 when nothing was. */
    downPayment: z.number().int().min(0).max(MAX_LINE_AMOUNT).default(0),
    /** How the DP was paid: the drawer or one of the store's accounts. */
    downPaymentAccount: zAccountRef.default(CASH_ACCOUNT),
    /** An EDC approval code, or a transfer's reference. */
    downPaymentReference: zReference,
  })
  .strict();
export type OpenTicketInput = z.input<typeof openTicketInput>;

export interface OpenTicketResult {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly customerId: string;
}

export async function openTicketHandler(
  input: z.output<typeof openTicketInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<OpenTicketResult>> {
  if (input.ticketId !== undefined) {
    const existing = await openedTicket(ctx, input.ticketId);
    if (existing !== null) return { ops: [], result: existing };
  }
  // Every angle this store asks for right now, so a list that changed under an open intake is
  // caught here rather than producing a ticket short of the evidence the owner wants.
  const offered = storeIntakeOptions(await loadIntakeOptions(ctx));
  const angles = offered.photoAngles;
  const repairTypes = repairTypesOrRefuse(
    recordRepairTypes(input.repairTypes, offered.repairTypes),
  );
  const taken = new Set(input.photos.map((photo) => photo.slot));
  const missing = angles.filter((angle) => !taken.has(angle.id));
  if (missing.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'photos', issue: 'a required intake photo is missing' },
      `missing intake photos: ${missing.map((angle) => angle.id).join(', ')}`,
    );
  }

  const ops: OpDraft[] = [];
  let customerId: string;
  if ('customerId' in input.customer) {
    // Throws ENTITY_NOT_FOUND for a customer not visible in this store.
    customerId = (await ctx.query(getCustomerQuery, { customerId: input.customer.customerId }))
      .rows[0]!.id;
  } else {
    customerId = ctx.newId();
    ops.push(
      ctx.op({
        type: REPAIR_OP.customerRegistered,
        entityType: REPAIR_CUSTOMER_ENTITY,
        entityId: customerId,
        payload: { name: input.customer.name, phone: input.customer.phone },
      }),
    );
  }

  // "Samsung" + "A15" is the catalog's Galaxy A15: store it the catalog's way, whichever screen or
  // keystroke order sent it, so the board and search name one phone one way.
  const catalog = (
    await ctx.query(findDeviceModelQuery, { brand: input.device.brand, model: input.device.model })
  ).rows[0];
  const device =
    catalog === undefined
      ? input.device
      : { ...input.device, brand: catalog.brand, model: catalog.model };

  const counter = (await ctx.query(nextTicketCounterQuery, { deviceId: ctx.deviceId })).rows[0]!
    .counter;
  const ticketNumber = formatTicketNumber(ctx.deviceId, counter);
  const ticketId = input.ticketId ?? ctx.newId();

  ops.push(
    ticketOp(ctx, ticketId, REPAIR_OP.ticketOpened, {
      ticketNumber,
      customerId,
      device,
      complaint: input.complaint,
      intakeNotes: input.intakeNotes,
      checklist: input.checklist,
      peripherals: input.peripherals,
      estimatedReadyAt: input.estimatedReadyAt,
      repairTypes,
      claimOf: input.claimOf,
      quoteLines: input.quoteLines.map((line) => ({ lineId: ctx.newId(), ...line })),
      photos: input.photos,
      ownershipVideo: input.ownershipVideo,
    }),
  );
  if (input.downPayment > 0) {
    const total = input.quoteLines.reduce((sum, line) => sum + line.amount, 0);
    checkDownPayment(input.downPayment, total);
    ops.push(
      paymentOp(ctx, ticketDocument(ticketId, ticketNumber), {
        account: input.downPaymentAccount,
        amount: input.downPayment,
        reference: input.downPaymentReference,
        tendered: null,
      }),
    );
  }

  return { ops, result: { ticketId, ticketNumber, customerId } };
}

/** The ticket already opened under `ticketId`, or null when there is none in this store. */
async function openedTicket(
  ctx: CommandContext,
  ticketId: string,
): Promise<OpenTicketResult | null> {
  try {
    const row = (await ctx.query(getTicketQuery, { ticketId })).rows[0]!;
    return { ticketId: row.id, ticketNumber: row.ticketNumber, customerId: row.customerId };
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'ENTITY_NOT_FOUND') return null;
    throw error;
  }
}

function repairTypesOrRefuse(recorded: ReturnType<typeof recordRepairTypes>): RecordedRepairType[] {
  if ('types' in recorded) return recorded.types;
  throw new DomainError(
    'VALIDATION_FAILED',
    { field: 'repairTypes', issue: 'not on the list' },
    `repair type ${recorded.unknown} is not on this store's list`,
  );
}

export const setRepairTypesInput = z
  .object({ ticketId: z.string().min(1), repairTypes: zRepairTypeIds })
  .strict();
export type SetRepairTypesInput = z.input<typeof setRepairTypesInput>;

/**
 * Change what is being repaired, once the diagnosis shows it. Types already on the servisan keep
 * their recorded terms; a store may still pick one it hides now if the servisan already had it.
 */
export async function setRepairTypesHandler(
  input: z.output<typeof setRepairTypesInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = (await ctx.query(getTicketQuery, { ticketId: input.ticketId })).rows[0]!;
  const offered = storeIntakeOptions(await loadIntakeOptions(ctx)).repairTypes;
  const repairTypes = repairTypesOrRefuse(
    recordRepairTypes(input.repairTypes, offered, ticket.repairTypes),
  );
  if (sameRepairTypes(repairTypes, ticket.repairTypes)) throw nothingChanged('repairTypes');
  return {
    ops: [ticketOp(ctx, ticket.id, REPAIR_OP.ticketRepairTypesChanged, { repairTypes })],
    result: { ticketId: ticket.id },
  };
}

// ── technician ─────────────────────────────────────────────────────────────────────────────────

const ticketIdInput = z.object({ ticketId: z.string().min(1) }).strict();
const ticketNoteInput = z
  .object({ ticketId: z.string().min(1), note: zText(2000).default('') })
  .strict();

export const claimTicketInput = ticketIdInput;
export type TicketIdInput = z.input<typeof ticketIdInput>;

export async function claimTicketHandler(
  input: z.output<typeof ticketIdInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [ticketOp(ctx, ticket.id, REPAIR_OP.ticketClaimed, {})],
    result: { ticketId: ticket.id },
  };
}

export const assignTechnicianInput = z
  .object({ ticketId: z.string().min(1), technicianId: z.uuid() })
  .strict();
export type AssignTechnicianInput = z.input<typeof assignTechnicianInput>;

export async function assignTechnicianHandler(
  input: z.output<typeof assignTechnicianInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.technicianAssigned, {
        technicianId: input.technicianId,
      }),
    ],
    result: { ticketId: ticket.id },
  };
}

const zWorkPhotos = z.array(zMediaRef).max(WORK_PHOTOS_MAX);

export const startWorkInput = z
  .object({ ticketId: z.string().min(1), beforePhotos: zWorkPhotos.default([]) })
  .strict();
export type StartWorkInput = z.input<typeof startWorkInput>;

/** The work-photo op for `photos`, or nothing when the command brought none. */
function workPhotosOp(
  ctx: CommandContext,
  ticketId: string,
  stage: WorkPhotoStage,
  photos: readonly MediaRef[],
): OpDraft[] {
  return photos.length === 0
    ? []
    : [ticketOp(ctx, ticketId, REPAIR_OP.workPhotosAdded, { stage, photos })];
}

/**
 * Start (or resume, or reopen) work. Starting an unassigned ticket claims it in the same command,
 * so a technician picking a device off the shelf needs one tap. The first start needs at least one
 * `before` photo; a resume keeps the ones already taken and may add more.
 */
export async function startWorkHandler(
  input: z.output<typeof startWorkInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const ops: OpDraft[] = [];
  if (ticket.technicianId === null) ops.push(ticketOp(ctx, ticket.id, REPAIR_OP.ticketClaimed, {}));
  ops.push(...workPhotosOp(ctx, ticket.id, 'before', input.beforePhotos));
  ops.push(ticketOp(ctx, ticket.id, REPAIR_OP.workStarted, {}));
  return { ops, result: { ticketId: ticket.id } };
}

export const markWaitingForPartsInput = ticketNoteInput;
export type TicketNoteInput = z.input<typeof ticketNoteInput>;

export async function markWaitingForPartsHandler(
  input: z.output<typeof ticketNoteInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [ticketOp(ctx, ticket.id, REPAIR_OP.workPaused, { note: input.note })],
    result: { ticketId: ticket.id },
  };
}

export const markRepairedInput = z
  .object({
    ticketId: z.string().min(1),
    note: zText(2000).default(''),
    afterPhotos: zWorkPhotos.min(1),
  })
  .strict();
export type MarkRepairedInput = z.input<typeof markRepairedInput>;

/** Mark the repair done, with at least one `after` photo each time (owner decision). */
export async function markRepairedHandler(
  input: z.output<typeof markRepairedInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [
      ...workPhotosOp(ctx, ticket.id, 'after', input.afterPhotos),
      ticketOp(ctx, ticket.id, REPAIR_OP.markedRepaired, { note: input.note }),
    ],
    result: { ticketId: ticket.id },
  };
}

// ── owner ────────────────────────────────────────────────────────────────────────────────────

const zFeeInput = z.number().int().min(0).max(MAX_LINE_AMOUNT);

export const cancelTicketInput = z
  .object({
    ticketId: z.string().min(1),
    reason: zRequiredText(2000),
    /**
     * What the customer pays when the owner changed it; left out, the store's fee for the ticket's
     * stage as this device knows it now, so a fee that syncs in meanwhile is never undercut.
     */
    fee: zFeeInput.optional(),
  })
  .strict();
export type CancelTicketInput = z.input<typeof cancelTicketInput>;

/**
 * Cancel an open ticket, owners only (the permission). A repaired phone can still be cancelled
 * when the customer won't pay or collect. Cancelling never moves the device: it stays "cancelled,
 * still in store" until handed back, and the handover shows the fee the customer signs for.
 */
export async function cancelTicketHandler(
  input: z.output<typeof cancelTicketInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const fees = (await ctx.query(cancelFeesQuery, {})).rows[0]!;
  const standardFee = standardCancelFee(ticket, fees);
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.ticketCancelled, {
        reason: input.reason,
        fee: input.fee ?? standardFee,
        standardFee,
      }),
    ],
    result: { ticketId: ticket.id },
  };
}

export const setCancelFeesInput = z
  .object({ beforeWork: zFeeInput, afterWork: zFeeInput })
  .strict();
export type SetCancelFeesInput = z.input<typeof setCancelFeesInput>;

/** Set this store's two cancellation fees. Tickets already cancelled keep what they charged. */
export async function setCancelFeesHandler(
  input: z.output<typeof setCancelFeesInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<CancelFees>> {
  if (ctx.storeId === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'beforeWork', issue: 'this device has no store' },
      'a store-less device cannot set cancellation fees',
    );
  }
  const current = (await ctx.query(cancelFeesQuery, {})).rows[0]!;
  if (current.beforeWork === input.beforeWork && current.afterWork === input.afterWork) {
    throw nothingChanged('beforeWork');
  }
  const fees = { beforeWork: input.beforeWork, afterWork: input.afterWork };
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.storeCancelFeesChanged,
        entityType: REPAIR_STORE_CANCEL_FEES_ENTITY,
        entityId: ctx.storeId,
        payload: fees,
      }),
    ],
    result: fees,
  };
}

export const setUncollectedDaysInput = z
  .object({ days: z.number().int().min(MIN_UNCOLLECTED_DAYS).max(MAX_UNCOLLECTED_DAYS) })
  .strict();
export type SetUncollectedDaysInput = z.input<typeof setUncollectedDaysInput>;

/** Set after how many days this store flags a ready phone nobody collected. Flagging only. */
export async function setUncollectedDaysHandler(
  input: z.output<typeof setUncollectedDaysInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ days: number }>> {
  if (ctx.storeId === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'days', issue: 'this device has no store' },
      'a store-less device cannot set when phones are flagged',
    );
  }
  const current = (await ctx.query(uncollectedDaysQuery, {})).rows[0]!;
  if (current.days === input.days) throw nothingChanged('days');
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.storeUncollectedDaysChanged,
        entityType: REPAIR_STORE_UNCOLLECTED_ENTITY,
        entityId: ctx.storeId,
        payload: { days: input.days },
      }),
    ],
    result: { days: input.days },
  };
}

const quoteChangeFields = {
  ticketId: z.string().min(1),
  kind: z.enum(QUOTE_LINE_KINDS),
  description: zRequiredText(200),
  amount: zAmountInput,
  reason: zRequiredText(2000),
};

export const proposeQuoteChangeInput = z.object(quoteChangeFields).strict();
export type ProposeQuoteChangeInput = z.input<typeof proposeQuoteChangeInput>;

/** A technician's suggested price change; it does not count until the cashier applies it. */
export async function proposeQuoteChangeHandler(
  input: z.output<typeof proposeQuoteChangeInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string; lineId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const lineId = ctx.newId();
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.quoteChangeProposed, {
        lineId,
        kind: input.kind,
        description: input.description,
        amount: input.amount,
        reason: input.reason,
      }),
    ],
    result: { ticketId: ticket.id, lineId },
  };
}

export const changeQuoteInput = z
  .object({ ...quoteChangeFields, customerAgreed: z.boolean() })
  .strict();
export type ChangeQuoteInput = z.input<typeof changeQuoteInput>;

export async function changeQuoteHandler(
  input: z.output<typeof changeQuoteInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string; lineId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const lineId = ctx.newId();
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.quoteChanged, {
        lineId,
        kind: input.kind,
        description: input.description,
        amount: input.amount,
        reason: input.reason,
        customerAgreed: input.customerAgreed,
        fromProposal: false,
        // Not agreed yet: it waits for the customer's answer and does not count until then.
        waitsForCustomer: !input.customerAgreed,
      }),
    ],
    result: { ticketId: ticket.id, lineId },
  };
}

/** The open proposal `lineId`: the command needs its kind and wording to apply it. */
function findProposal(ticket: TicketDetailRow, lineId: string, event: string) {
  const line = ticket.quoteLines.find((candidate) => candidate.id === lineId);
  requireProposal(ticket, line, lineId, event);
  return line!;
}

export const applyProposalInput = z
  .object({
    ticketId: z.string().min(1),
    lineId: z.string().min(1),
    /** A price change counts only once the customer agreed (product-scope.md, price changes). */
    customerAgreed: z.literal(true),
    /** The cashier may settle on a different description or amount than proposed. */
    description: zRequiredText(200).optional(),
    amount: zAmountInput.optional(),
    note: zText(2000).default(''),
  })
  .strict();
export type ApplyProposalInput = z.input<typeof applyProposalInput>;

export async function applyProposalHandler(
  input: z.output<typeof applyProposalInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string; lineId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const proposal = findProposal(ticket, input.lineId, REPAIR_OP.quoteChanged);
  const amount = input.amount ?? proposal.amount;
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.quoteChanged, {
        lineId: proposal.id,
        kind: proposal.kind,
        description: input.description ?? proposal.description,
        amount,
        reason: input.note === '' ? (proposal.reason ?? proposal.description) : input.note,
        customerAgreed: input.customerAgreed,
        fromProposal: true,
        waitsForCustomer: false,
      }),
    ],
    result: { ticketId: ticket.id, lineId: proposal.id },
  };
}

export const declineProposalInput = z
  .object({ ticketId: z.string().min(1), lineId: z.string().min(1), note: zText(2000).default('') })
  .strict();
export type DeclineProposalInput = z.input<typeof declineProposalInput>;

export async function declineProposalHandler(
  input: z.output<typeof declineProposalInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string; lineId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.quoteProposalDeclined, {
        lineId: input.lineId,
        note: input.note,
      }),
    ],
    result: { ticketId: ticket.id, lineId: input.lineId },
  };
}

export const returnDeviceInput = z
  .object({
    ticketId: z.string().min(1),
    handoverPhoto: zMediaRef,
    signature: zMediaRef,
    note: zText(2000).default(''),
    /** What the customer pays now, in one or more methods. */
    payments: z.array(zPaymentInput).max(10).default([]),
    /** An owner lets the phone go before it is paid in full, and says why: a debt. */
    unpaidReason: zText(2000)
      .nullable()
      .default(null)
      .transform((reason) => (reason === null || reason === '' ? null : reason)),
    /** What the counter went through with the customer (`handoverChecklist`), ticked or not. */
    checklist: z
      .array(zHandoverCheck)
      .max(MAX_OPTIONS + 50)
      .default([]),
  })
  .strict();
export type ReturnDeviceInput = z.input<typeof returnDeviceInput>;

/**
 * Money handed back at the counter, through the accounts that overpaid as the money rule reads
 * them (`refundSplit`), as the handover screens show it (`TicketDetailRow.refunds`). The bill is
 * what the servisan is charged once this handover's charge is recorded; `extra` are the payments
 * taken now.
 */
export function refundsFor(
  money: DocumentMoney,
  credit: number,
  bill: number,
  extra: readonly { account: string; amount: number }[] = [],
): { account: string; amount: number }[] {
  return refundSplit(
    [
      ...money.entries,
      ...extra.map((payment) => ({ ...payment, kind: 'payment_received', voidedBy: null })),
    ],
    credit,
    bill,
  );
}

/**
 * Hand the device back, with a photo and the customer's signature (when: `deviceReturnedRule`).
 * The servisan is charged what it costs, the customer pays the rest, and what they paid beyond
 * it goes back through the accounts it came in by. Only an owner lets it go unpaid.
 */
export async function returnDeviceHandler(
  input: z.output<typeof returnDeviceInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const ops: OpDraft[] = [];
  let balance = 0;
  // A phone that cannot leave yet is left to `deviceReturnedRule` to refuse, in its own words.
  const settles =
    ticket.location === 'in_store' &&
    (ticket.outcome === 'repaired' || ticket.outcome === 'cancelled');
  if (settles) {
    const document = ticketDocument(ticket.id, ticket.ticketNumber);
    const money = await ticketMoney(ctx, ticket.id);
    // `settles` means the outcome is settled, so there is a charge.
    const charge = ticketCharge(ticket)!;
    const toCharge = Math.max(0, charge.amount - money.charged);
    if (toCharge > 0) ops.push(chargeOp(ctx, document, toCharge, charge.account));
    for (const payment of input.payments) ops.push(paymentOp(ctx, document, payment));

    const paidNow = input.payments.reduce((sum, payment) => sum + payment.amount, 0);
    balance = money.balance + toCharge - paidNow;
    if (balance < 0) {
      const bill = money.charged + toCharge - money.reduced;
      for (const refund of refundsFor(money, -balance, bill, input.payments)) {
        ops.push(
          refundOp(ctx, document, { ...refund, reason: HANDOVER_REFUND_REASON, reference: null }),
        );
      }
    }
  }

  ops.push(
    ticketOp(ctx, ticket.id, REPAIR_OP.deviceReturned, {
      handoverPhoto: input.handoverPhoto,
      signature: input.signature,
      note: input.note,
      unpaidReason: balance > 0 ? input.unpaidReason : null,
      checklist: input.checklist,
    }),
  );
  return { ops, result: { ticketId: ticket.id } };
}

// ── down payment, printing and the store's slip settings ──────────────────────────────────────

export const recordDownPaymentInput = z
  .object({
    ticketId: z.string().min(1),
    amount: z.number().int().min(1).max(MAX_LINE_AMOUNT),
    account: zAccountRef.default(CASH_ACCOUNT),
    reference: zReference,
  })
  .strict();
export type RecordDownPaymentInput = z.input<typeof recordDownPaymentInput>;

/**
 * A down payment taken after intake, while the servisan is open, into the money ledger. Lowering
 * it afterwards is an owner's correction, since a lower figure is how cash would go missing.
 */
export async function recordDownPaymentHandler(
  input: z.output<typeof recordDownPaymentInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  if (ticket.location === 'returned' || ticket.outcome === 'cancelled') {
    throw REPAIR_REFUSALS.refuse(ticket.location === 'returned' ? 'returned' : 'cancelled', {
      details: { entityType: REPAIR_TICKET_ENTITY, entityId: ticket.id },
    });
  }
  checkDownPayment((ticket.downPayment ?? 0) + input.amount, ticket.quoteTotal);
  return {
    ops: [
      paymentOp(ctx, ticketDocument(ticket.id, ticket.ticketNumber), {
        account: input.account,
        amount: input.amount,
        reference: input.reference,
        tendered: null,
      }),
    ],
    result: { ticketId: ticket.id },
  };
}

export const correctDownPaymentInput = z
  .object({
    ticketId: z.string().min(1),
    /** What the down payment should be; 0 removes it. */
    amount: z.number().int().min(0).max(MAX_LINE_AMOUNT),
    // The voids carry it, and a money reason is at most 500.
    reason: zRequiredText(500),
    /** How the right amount came in; the first payment's method when not said. */
    account: zAccountRef.optional(),
    reference: zReference,
  })
  .strict();
export type CorrectDownPaymentInput = z.input<typeof correctDownPaymentInput>;

/**
 * An owner corrects a down payment, with a reason. Raising it keeps the payments taken so far and
 * records only the difference through the method picked, so cash already in the drawer stays
 * there. Lowering it voids the payments taken so far and, when the amount is not 0, records one
 * payment of the right amount through the method picked (the first payment's, unless said).
 */
export async function correctDownPaymentHandler(
  input: z.output<typeof correctDownPaymentInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  const details = { entityType: REPAIR_TICKET_ENTITY, entityId: ticket.id };
  // After pickup the DP is part of the bill the customer paid; and money already handed back
  // would be paid out a second time if the payments were simply re-recorded.
  if (ticket.location === 'returned') throw REPAIR_REFUSALS.refuse('returned', { details });
  if ((ticket.downPayment ?? 0) === input.amount) throw nothingChanged('amount');
  const money = await ticketMoney(ctx, ticket.id);
  if (money.entries.some((entry) => entry.kind === 'refund_paid')) {
    throw REPAIR_REFUSALS.refuse('downPaymentRefunded', { details });
  }
  const live = money.entries.filter(
    (entry) => entry.kind === 'payment_received' && entry.voidedAt === null,
  );
  const ops: OpDraft[] = [];
  const first = live[0];
  const method =
    input.account === undefined
      ? { account: first?.account ?? CASH_ACCOUNT, reference: first?.reference ?? null }
      : { account: input.account, reference: input.reference };
  const recorded = ticket.downPayment ?? 0;
  if (input.amount > recorded) {
    // The customer paid more: what was taken stays where it is.
    ops.push(
      paymentOp(ctx, ticketDocument(ticket.id, ticket.ticketNumber), {
        ...method,
        amount: input.amount - recorded,
        tendered: null,
      }),
    );
    return { ops, result: { ticketId: ticket.id } };
  }
  if (input.amount > 0) {
    // Recorded first, in place of the largest payment through the same account, so a limited
    // role's refund limit counts only what the DP went down by there.
    const replaced = live
      .filter((entry) => entry.account === method.account)
      .reduce<(typeof live)[number] | undefined>(
        (largest, entry) =>
          largest === undefined || entry.amount > largest.amount ? entry : largest,
        undefined,
      );
    ops.push(
      paymentOp(ctx, ticketDocument(ticket.id, ticket.ticketNumber), {
        ...method,
        amount: input.amount,
        tendered: null,
        ...(replaced === undefined ? {} : { replaces: replaced.id }),
      }),
    );
  }
  for (const entry of live) ops.push(voidOp(ctx, entry.id, input.reason));
  return { ops, result: { ticketId: ticket.id } };
}

export const recordSlipPrintedInput = z
  .object({ ticketId: z.string().min(1), slip: z.enum(SLIP_KINDS) })
  .strict();
export type RecordSlipPrintedInput = z.input<typeof recordSlipPrintedInput>;

/**
 * Log that a slip was printed or shared, so the next one says "Cetak ulang". The handover slip is
 * the customer's bill and receipt, so it exists only once the phone is ready to collect or gone.
 */
export async function recordSlipPrintedHandler(
  input: z.output<typeof recordSlipPrintedInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  return {
    ops: [ticketOp(ctx, ticket.id, REPAIR_OP.slipPrinted, { slip: input.slip })],
    result: { ticketId: ticket.id },
  };
}

const zOptionalTerms = z
  .string()
  .max(MAX_TERMS)
  .nullable()
  .transform((terms) => (terms === null || terms.trim() === '' ? null : terms.trim()));

export const setPrintSettingsInput = z
  .object({
    /** Empty prints the store's own name. */
    name: z
      .string()
      .max(100)
      .transform((name) => (name.trim() === '' ? null : name.trim())),
    address: zText(300),
    phone: zText(100),
    /** Left out keeps the logo as it is; null removes it. */
    logo: zMediaRef.nullable().optional(),
    logoOnDotMatrix: z.boolean(),
    /** Empty or null prints the app's default terms. */
    intakeTerms: zOptionalTerms,
    handoverTerms: zOptionalTerms,
  })
  .strict();
export type SetPrintSettingsInput = z.input<typeof setPrintSettingsInput>;

function samePrintSettings(
  current: PrintSettings,
  next: z.output<typeof setPrintSettingsInput>,
): boolean {
  return (
    current.name === next.name &&
    current.address === next.address &&
    current.phone === next.phone &&
    (next.logo === undefined || (current.logo?.mediaId ?? null) === (next.logo?.mediaId ?? null)) &&
    current.logoOnDotMatrix === next.logoOnDotMatrix &&
    current.intakeTerms === next.intakeTerms &&
    current.handoverTerms === next.handoverTerms
  );
}

/** Set what this store's slips print at the top and in their terms. Printed paper is unchanged. */
export async function setPrintSettingsHandler(
  input: z.output<typeof setPrintSettingsInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ storeId: string }>> {
  if (ctx.storeId === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'name', issue: 'this device has no store' },
      'a store-less device cannot set print settings',
    );
  }
  const current = (await ctx.query(printSettingsQuery, {})).rows[0]!;
  if (samePrintSettings(current, input)) throw nothingChanged('name');
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.storePrintSettingsChanged,
        entityType: REPAIR_STORE_PRINT_SETTINGS_ENTITY,
        entityId: ctx.storeId,
        payload: input as unknown as Record<string, unknown>,
      }),
    ],
    result: { storeId: ctx.storeId },
  };
}

// ── intake options (the owner's lists) ────────────────────────────────────────────────────────

async function loadIntakeOptions(ctx: CommandContext): Promise<IntakeOptionSettings> {
  return (await ctx.query(intakeOptionSettingsQuery, {})).rows[0]!;
}

function nothingChanged(field: string): DomainError {
  return new DomainError(
    'VALIDATION_FAILED',
    { field, issue: 'nothing changed' },
    'the saved list is identical to the current one',
  );
}

export const changeIntakeOptionsInput = z
  .object({
    list: z.enum(INTAKE_OPTION_LISTS),
    /** The whole list in order. A new item has no id yet; one is minted here. */
    items: z
      .array(
        z
          .object({
            id: zOptionId.nullable(),
            /** What the owner typed; null keeps a built-in item's app name. */
            label: z.string().trim().max(200).nullable(),
            /** A repair type's warranty and whether it needs an ownership video. */
            warrantyDays: z.number().int().optional(),
            needsVideo: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_OPTIONS),
  })
  .strict();
export type ChangeIntakeOptionsInput = z.input<typeof changeIntakeOptionsInput>;

/** Replace one franchise list (tenant-wide: every store's intake follows it after sync). */
export async function changeIntakeOptionsHandler(
  input: z.output<typeof changeIntakeOptionsInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ list: IntakeOptionList }>> {
  const items: IntakeOption[] = input.items.map(({ id, label, warrantyDays, needsVideo }) => ({
    id: id ?? ctx.newId(),
    label,
    ...(warrantyDays === undefined ? {} : { warrantyDays }),
    ...(needsVideo === undefined ? {} : { needsVideo }),
  }));
  const problems = intakeListProblems(input.list, items);
  if (problems.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'items', issue: problems.join(', ') },
      `the ${input.list} list cannot be saved: ${problems.join(', ')}`,
    );
  }
  const current = await loadIntakeOptions(ctx);
  if (sameOptions(current.lists[input.list], items)) throw nothingChanged('items');
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.intakeOptionsChanged,
        entityType: REPAIR_INTAKE_OPTIONS_ENTITY,
        entityId: ctx.tenantId,
        payload: { list: input.list, items: items as unknown as Record<string, unknown>[] },
      }),
    ],
    result: { list: input.list },
  };
}

export const hideIntakeOptionsInput = z
  .object({
    list: z.enum(INTAKE_OPTION_LISTS),
    /** Every item this store hides on the list; anything not named shows. */
    hidden: z.array(zOptionId).max(MAX_OPTIONS),
  })
  .strict();
export type HideIntakeOptionsInput = z.input<typeof hideIntakeOptionsInput>;

/** Replace the set of one list's items this store hides. */
export async function hideIntakeOptionsHandler(
  input: z.output<typeof hideIntakeOptionsInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ list: IntakeOptionList }>> {
  if (ctx.storeId === null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'hidden', issue: 'this device has no store' },
      'a store-less device cannot hide intake options',
    );
  }
  const current = await loadIntakeOptions(ctx);
  // Only items on the franchise list, in its order: an id the owner removed meanwhile is dropped.
  const wanted = new Set(input.hidden);
  const hidden = current.lists[input.list].filter((item) => wanted.has(item.id)).map((i) => i.id);
  if (NON_EMPTY_LISTS.has(input.list) && hidden.length === current.lists[input.list].length) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'hidden', issue: 'at least one item must stay' },
      `a store cannot hide every ${input.list} item`,
    );
  }
  const before = current.hidden[input.list];
  if (before.length === hidden.length && before.every((id, i) => id === hidden[i])) {
    throw nothingChanged('hidden');
  }
  return {
    ops: [
      ctx.op({
        type: REPAIR_OP.storeIntakeOptionsChanged,
        entityType: REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
        entityId: ctx.storeId,
        payload: { list: input.list, hidden },
      }),
    ],
    result: { list: input.list },
  };
}
