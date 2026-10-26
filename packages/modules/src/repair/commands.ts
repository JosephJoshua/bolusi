// The `repair` commands: the only write path. Handlers are pure; they read through `ctx.query`
// and return op drafts. Business rules a device can check locally (who may do what, which
// transitions are allowed) are refused here with `INVALID_TRANSITION`/`VALIDATION_FAILED`; the
// appliers stay total so concurrent offline work still folds.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';
import { zMediaRef, type MediaRef } from '@bolusi/schemas';

import {
  MAX_LINE_AMOUNT,
  QUOTE_LINE_KINDS,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_INTAKE_OPTIONS_ENTITY,
  REPAIR_OP,
  REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  REPAIR_PERMISSION,
  REPAIR_TICKET_ENTITY,
  WORK_PHOTOS_MAX,
  workPhotoStage,
  type QuoteLineKind,
  type RepairOutcome,
  type WorkPhotoStage,
} from './constants.js';
import {
  INTAKE_OPTION_LISTS,
  MAX_OPTIONS,
  NON_EMPTY_LISTS,
  intakeListProblems,
  sameOptions,
  storeIntakeOptions,
  type IntakeOption,
  type IntakeOptionList,
  type IntakeOptionSettings,
} from './intake-options.js';
import {
  zChecklistItemV2,
  zDevice,
  zIntakePhotosV2,
  zOptionId,
  zRecordedOption,
} from './operations.js';
import {
  getCustomerQuery,
  getTicketQuery,
  intakeOptionSettingsQuery,
  nextTicketCounterQuery,
  type TicketDetailRow,
} from './queries.js';
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

/** Parts and labour add to the price, discounts subtract; adjustments may go either way. */
function checkLineSign(kind: QuoteLineKind, amount: number): void {
  const ok = kind === 'discount' ? amount <= 0 : kind === 'adjustment' ? true : amount >= 0;
  if (!ok) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'amount', issue: `${kind} amount has the wrong sign` },
      `a ${kind} line cannot have amount ${amount}`,
    );
  }
}

/**
 * The agreed price can come down to nothing, but never below: the store would owe the customer.
 * Only a line that lowers the total is refused, so a total that offline merges already pushed
 * below zero can still be corrected upwards.
 */
function checkTotal(current: number, change: number): void {
  const total = current + change;
  if (change < 0 && total < 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'amount', issue: 'the total price would be negative' },
      `the total price cannot be ${total}`,
    );
  }
}

function invalidTransition(ticket: TicketDetailRow, event: string, why: string): DomainError {
  return new DomainError(
    'INVALID_TRANSITION',
    {
      machine: REPAIR_TICKET_ENTITY,
      from: `${ticket.outcome}/${ticket.location}`,
      event,
      entityId: ticket.id,
    },
    `ticket ${ticket.ticketNumber}: ${why}`,
  );
}

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

/** A ticket that is still being worked on: in the store and not cancelled. */
function requireOpen(ticket: TicketDetailRow, event: string): void {
  if (ticket.location === 'returned') {
    throw invalidTransition(ticket, event, 'the device has already been returned');
  }
  if (ticket.outcome === 'cancelled') {
    throw invalidTransition(ticket, event, 'the ticket is cancelled');
  }
}

function requireOutcome(
  ticket: TicketDetailRow,
  event: string,
  allowed: readonly RepairOutcome[],
): void {
  requireOpen(ticket, event);
  if (!allowed.includes(ticket.outcome)) {
    throw invalidTransition(ticket, event, `not allowed while ${ticket.outcome}`);
  }
}

function ticketOp(ctx: CommandContext, ticketId: string, type: string, payload: object) {
  return ctx.op({
    type,
    entityType: REPAIR_TICKET_ENTITY,
    entityId: ticketId,
    payload: payload as Record<string, unknown>,
  });
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

// ── openTicket (the one-sitting intake) ────────────────────────────────────────────────────────

export const openTicketInput = z
  .object({
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
    estimatedReadyAt: z.number().int().nullable().default(null),
    quoteLines: z.array(zLineInput).min(1).max(100),
    /** One photo per angle the store asks for, labelled as the counter saw it. */
    photos: zIntakePhotosV2,
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
  for (const line of input.quoteLines) checkLineSign(line.kind, line.amount);
  checkTotal(
    0,
    input.quoteLines.reduce((sum, line) => sum + line.amount, 0),
  );
  // Every angle this store asks for right now, so a list that changed under an open intake is
  // caught here rather than producing a ticket short of the evidence the owner wants.
  const angles = storeIntakeOptions(await loadIntakeOptions(ctx)).photoAngles;
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

  const counter = (await ctx.query(nextTicketCounterQuery, { deviceId: ctx.deviceId })).rows[0]!
    .counter;
  const ticketNumber = formatTicketNumber(ctx.deviceId, counter);
  const ticketId = ctx.newId();

  ops.push(
    ticketOp(ctx, ticketId, REPAIR_OP.ticketOpened, {
      ticketNumber,
      customerId,
      device: input.device,
      complaint: input.complaint,
      intakeNotes: input.intakeNotes,
      checklist: input.checklist,
      peripherals: input.peripherals,
      estimatedReadyAt: input.estimatedReadyAt,
      quoteLines: input.quoteLines.map((line) => ({ lineId: ctx.newId(), ...line })),
      photos: input.photos,
    }),
  );

  return { ops, result: { ticketId, ticketNumber, customerId } };
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
  requireOpen(ticket, REPAIR_OP.ticketClaimed);
  if (ticket.technicianId === ctx.userId) {
    throw invalidTransition(ticket, REPAIR_OP.ticketClaimed, 'already yours');
  }
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
  requireOpen(ticket, REPAIR_OP.technicianAssigned);
  if (ticket.technicianId === input.technicianId) {
    throw invalidTransition(ticket, REPAIR_OP.technicianAssigned, 'already assigned to them');
  }
  // The picker only lists people who can do repair work; a crafted or stale input must not park a
  // customer's phone with someone who can never start it.
  if (!ctx.colleagueHasPermission(input.technicianId, REPAIR_PERMISSION.work)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'technicianId', issue: 'cannot do repair work in this store' },
      `user ${input.technicianId} cannot do repair work`,
    );
  }
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

function missingPhotos(stage: WorkPhotoStage, why: string): DomainError {
  return new DomainError(
    'VALIDATION_FAILED',
    { field: `${stage}Photos`, issue: 'at least one photo is required' },
    why,
  );
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
  requireOutcome(ticket, REPAIR_OP.workStarted, ['received', 'waiting_for_parts', 'repaired']);
  const hasBefore = ticket.photos.some((photo) => workPhotoStage(photo.slot) === 'before');
  if (!hasBefore && input.beforePhotos.length === 0) {
    throw missingPhotos('before', `ticket ${ticket.ticketNumber} has no before photo yet`);
  }
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
  requireOutcome(ticket, REPAIR_OP.workPaused, ['received', 'in_repair']);
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
  requireOutcome(ticket, REPAIR_OP.markedRepaired, ['in_repair']);
  return {
    ops: [
      ...workPhotosOp(ctx, ticket.id, 'after', input.afterPhotos),
      ticketOp(ctx, ticket.id, REPAIR_OP.markedRepaired, { note: input.note }),
    ],
    result: { ticketId: ticket.id },
  };
}

// ── cashier ──────────────────────────────────────────────────────────────────────────────────

export const cancelTicketInput = z
  .object({ ticketId: z.string().min(1), reason: zRequiredText(2000) })
  .strict();
export type CancelTicketInput = z.input<typeof cancelTicketInput>;

/** Cancelling never moves the device: it stays "cancelled, still in store" until handed back. */
export async function cancelTicketHandler(
  input: z.output<typeof cancelTicketInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  requireOpen(ticket, REPAIR_OP.ticketCancelled);
  return {
    ops: [ticketOp(ctx, ticket.id, REPAIR_OP.ticketCancelled, { reason: input.reason })],
    result: { ticketId: ticket.id },
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
  checkLineSign(input.kind, input.amount);
  const ticket = await loadTicket(ctx, input.ticketId);
  requireOpen(ticket, REPAIR_OP.quoteChangeProposed);
  // A proposal the cashier could never apply would only block handover until declined.
  checkTotal(ticket.quoteTotal, input.amount);
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
  checkLineSign(input.kind, input.amount);
  const ticket = await loadTicket(ctx, input.ticketId);
  requireOpen(ticket, REPAIR_OP.quoteChanged);
  checkTotal(ticket.quoteTotal, input.amount);
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
      }),
    ],
    result: { ticketId: ticket.id, lineId },
  };
}

function findProposal(ticket: TicketDetailRow, lineId: string, event: string) {
  const line = ticket.quoteLines.find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: 'repair_quote_line',
      entityId: lineId,
    });
  }
  if (line.status !== 'proposed') {
    throw invalidTransition(ticket, event, `quote line ${lineId} is ${line.status}`);
  }
  return line;
}

export const applyProposalInput = z
  .object({
    ticketId: z.string().min(1),
    lineId: z.string().min(1),
    customerAgreed: z.boolean(),
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
  requireOpen(ticket, REPAIR_OP.quoteChanged);
  const proposal = findProposal(ticket, input.lineId, REPAIR_OP.quoteChanged);
  const amount = input.amount ?? proposal.amount;
  checkLineSign(proposal.kind, amount);
  checkTotal(ticket.quoteTotal, amount);
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
  findProposal(ticket, input.lineId, REPAIR_OP.quoteProposalDeclined);
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
  })
  .strict();
export type ReturnDeviceInput = z.input<typeof returnDeviceInput>;

/**
 * Hand the device back. Allowed once it is repaired or cancelled. On a repaired ticket open
 * technician proposals must be decided first, because they could change what the customer owes; on
 * a cancelled one they can no longer be decided, so they must not keep the phone in the store.
 */
export async function returnDeviceHandler(
  input: z.output<typeof returnDeviceInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ ticketId: string }>> {
  const ticket = await loadTicket(ctx, input.ticketId);
  if (ticket.location === 'returned') {
    throw invalidTransition(ticket, REPAIR_OP.deviceReturned, 'already returned');
  }
  if (ticket.outcome !== 'repaired' && ticket.outcome !== 'cancelled') {
    throw invalidTransition(ticket, REPAIR_OP.deviceReturned, 'repair is not finished');
  }
  if (ticket.outcome === 'repaired' && ticket.pendingProposals > 0) {
    throw invalidTransition(ticket, REPAIR_OP.deviceReturned, 'price proposals are undecided');
  }
  return {
    ops: [
      ticketOp(ctx, ticket.id, REPAIR_OP.deviceReturned, {
        handoverPhoto: input.handoverPhoto,
        signature: input.signature,
        note: input.note,
      }),
    ],
    result: { ticketId: ticket.id },
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
  const items: IntakeOption[] = input.items.map((item) => ({
    id: item.id ?? ctx.newId(),
    label: item.label,
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
