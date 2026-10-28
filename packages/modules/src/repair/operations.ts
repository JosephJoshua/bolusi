// The `repair` op registry: payload schemas, reversal notes, appliers and conflict keys.
//
// All ops are store-scoped (the default). Payloads are strict and carry no floats; money is
// integer IDR. Photos travel as whole signed `mediaRef`s so a pulled ticket can verify the bytes
// it downloads (same reasoning as notes v3).
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zMediaRef, zMoneyIdr, zMsEpoch, zUuid, zUuidV7 } from '@bolusi/schemas';

import {
  intakeOptionsChangedApplier,
  storeIntakeOptionsChangedApplier,
  storeCancelFeesChangedApplier,
  storeUncollectedDaysChangedApplier,
  customerDetailsCorrectedApplier,
  customerRegisteredApplier,
  deviceReturnedApplier,
  downPaymentChangedApplier,
  markedRepairedApplier,
  quoteChangedApplier,
  quoteChangeProposedApplier,
  quoteProposalDeclinedApplier,
  slipPrintedApplier,
  storePrintSettingsChangedApplier,
  technicianAssignedApplier,
  ticketCancelledApplier,
  ticketClaimedApplier,
  ticketOpenedApplier,
  ticketRepairTypesChangedApplier,
  workPausedApplier,
  workPhotosAddedApplier,
  workStartedApplier,
} from './applier.js';
import {
  CHECKLIST_STATES,
  HANDOVER_PHOTO_SLOTS,
  MAX_LINE_AMOUNT,
  MAX_UNCOLLECTED_DAYS,
  MIN_UNCOLLECTED_DAYS,
  QUOTE_LINE_KINDS,
  REPAIR_CONFLICT_KEY,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_INTAKE_OPTIONS_ENTITY,
  REPAIR_OP,
  REPAIR_PERMISSION,
  REPAIR_STORE_CANCEL_FEES_ENTITY,
  REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  REPAIR_STORE_PRINT_SETTINGS_ENTITY,
  REPAIR_STORE_UNCOLLECTED_ENTITY,
  REPAIR_TICKET_ENTITY,
  SLIP_KINDS,
  WORK_PHOTO_STAGES,
  WORK_PHOTOS_MAX,
} from './constants.js';
import {
  INTAKE_OPTION_LISTS,
  MAX_LABEL,
  MAX_OPTIONS,
  MAX_WARRANTY_DAYS,
} from './intake-options.js';
import {
  customerDetailsCorrectedRule,
  customerRegisteredRule,
  deviceReturnedRule,
  downPaymentCorrectedRule,
  downPaymentReceivedRule,
  intakeOptionsChangedRule,
  markedRepairedRule,
  ownStoreSettingRule,
  quoteChangedRule,
  quoteChangeProposedRule,
  quoteProposalDeclinedRule,
  slipPrintedRule,
  technicianAssignedRule,
  ticketCancelledRule,
  ticketClaimedRule,
  ticketOpenedRule,
  ticketRepairTypesChangedRule,
  workPausedRule,
  workPhotosAddedRule,
  workStartedRule,
} from './rules.js';
import type { RepairDatabase } from './schema.js';

const MAX_TEXT = 2000;
const zName = z.string().trim().min(1).max(200);
const zShortText = z.string().max(200);
const zLongText = z.string().max(MAX_TEXT);
/** A plausible money bound: 1 trillion IDR either way. */
const zAmount = zMoneyIdr.min(-1_000_000_000_000).max(1_000_000_000_000);

export const zChecklistItem = z
  .object({
    item: z.string().min(1).max(100),
    state: z.enum(CHECKLIST_STATES),
    note: zShortText,
  })
  .strict();

/**
 * An intake option's id: a built-in key ("screen") or a generated id. No `:`, so an intake photo
 * angle can never be read as a work photo slot (`before:<mediaId>`), and never a handover slot.
 */
export const zOptionId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((id) => !(HANDOVER_PHOTO_SLOTS as readonly string[]).includes(id), {
    message: 'reserved for handover photos',
  });

/** The name an option showed at intake; null for a built-in shown under its app name. */
const zRecordedLabel = z.string().trim().min(1).max(MAX_LABEL).nullable();

export const zChecklistItemV2 = z
  .object({
    item: zOptionId,
    label: zRecordedLabel,
    state: z.enum(CHECKLIST_STATES),
    note: zShortText,
  })
  .strict();

export const zRecordedOption = z.object({ item: zOptionId, label: zRecordedLabel }).strict();

const zWarrantyDays = z.number().int().min(0).max(MAX_WARRANTY_DAYS);

/** The most repair types one servisan records. */
export const MAX_TICKET_REPAIR_TYPES = 10;

/**
 * A repair type as a servisan recorded it: its name and its terms then, so a later change to the
 * owner's list never changes the warranty a customer was given.
 */
export const zRecordedRepairType = zRecordedOption
  .extend({ warrantyDays: zWarrantyDays, needsVideo: z.boolean() })
  .strict();

export const zRecordedRepairTypes = z
  .array(zRecordedRepairType)
  .max(MAX_TICKET_REPAIR_TYPES)
  .refine((types) => new Set(types.map((type) => type.item)).size === types.length, {
    message: 'a repair type is listed twice',
  });

export const zIntakePhoto = z
  .object({ slot: zOptionId, label: zRecordedLabel, ref: zMediaRef })
  .strict();

/** Intake photos as taken, one per angle; at least one, so every ticket has evidence. */
export const zIntakePhotosV2 = z
  .array(zIntakePhoto)
  .min(1)
  .max(MAX_OPTIONS)
  .refine((photos) => new Set(photos.map((p) => p.slot)).size === photos.length, {
    message: 'one photo per angle',
  });

export const zQuoteLineDraft = z
  .object({
    lineId: zUuidV7,
    kind: z.enum(QUOTE_LINE_KINDS),
    description: z.string().trim().min(1).max(200),
    amount: zAmount,
  })
  .strict();

export const zDevice = z
  .object({
    brand: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    color: zShortText,
    imei: z.string().max(40).nullable(),
    passcode: z.string().max(200).nullable(),
  })
  .strict();

export const zIntakePhotos = z
  .object({
    front: zMediaRef,
    back: zMediaRef,
    left: zMediaRef,
    right: zMediaRef,
    top: zMediaRef,
    bottom: zMediaRef,
  })
  .strict();

export const customerRegisteredPayload = z
  .object({ name: zName, phone: z.string().max(40).nullable() })
  .strict();

export const customerDetailsCorrectedPayload = customerRegisteredPayload;

/** `repair.ticket_opened` v1, before intake lists were editable: six fixed photos, keys only. */
export const ticketOpenedPayloadV1 = z
  .object({
    ticketNumber: z.string().min(1).max(40),
    customerId: zUuid,
    device: zDevice,
    complaint: z.string().trim().min(1).max(MAX_TEXT),
    intakeNotes: zLongText,
    checklist: z.array(zChecklistItem).max(100),
    peripherals: z.array(z.string().min(1).max(100)).max(50),
    estimatedReadyAt: zMsEpoch.nullable(),
    quoteLines: z.array(zQuoteLineDraft).min(1).max(100),
    photos: zIntakePhotos,
  })
  .strict();

/**
 * `repair.ticket_opened` v2: checks, accessories and photos carry the label the counter saw, and
 * the photos are whichever angles the store asked for, in order.
 */
export const ticketOpenedPayloadV2 = ticketOpenedPayloadV1
  .extend({
    checklist: z.array(zChecklistItemV2).max(100),
    peripherals: z.array(zRecordedOption).max(50),
    photos: zIntakePhotosV2,
  })
  .strict();

/** `repair.ticket_opened` v3: the repair types picked at intake, with their terms (may be none). */
export const ticketOpenedPayload = ticketOpenedPayloadV2
  .extend({ repairTypes: zRecordedRepairTypes })
  .strict();

/** The repair types of an open servisan, replacing the previous ones (after the diagnosis). */
export const ticketRepairTypesChangedPayload = z
  .object({ repairTypes: zRecordedRepairTypes })
  .strict();

/** The lists before repair types joined them (v1 of both list ops). */
const V1_LISTS = ['checks', 'accessories', 'photoAngles', 'brands', 'readyBy'] as const;

export const intakeOptionsChangedPayloadV1 = z
  .object({
    list: z.enum(V1_LISTS),
    items: z.array(z.object({ id: zOptionId, label: zRecordedLabel }).strict()).max(MAX_OPTIONS),
  })
  .strict();

/**
 * The whole of one franchise list, replacing the previous one (last save wins). v2: repair types,
 * whose items carry their warranty and whether they need an ownership video.
 */
export const intakeOptionsChangedPayload = z
  .object({
    list: z.enum(INTAKE_OPTION_LISTS),
    items: z
      .array(
        z
          .object({
            id: zOptionId,
            label: zRecordedLabel,
            warrantyDays: zWarrantyDays.optional(),
            needsVideo: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_OPTIONS),
  })
  .strict();

export const storeIntakeOptionsChangedPayloadV1 = z
  .object({ list: z.enum(V1_LISTS), hidden: z.array(zOptionId).max(MAX_OPTIONS) })
  .strict();

/** The whole set of one list's items a store hides, replacing the previous set. v2: repair types. */
export const storeIntakeOptionsChangedPayload = z
  .object({
    list: z.enum(INTAKE_OPTION_LISTS),
    hidden: z.array(zOptionId).max(MAX_OPTIONS),
  })
  .strict();

const emptyPayload = z.object({}).strict();
export const technicianAssignedPayload = z.object({ technicianId: zUuid }).strict();
export const notePayload = z.object({ note: zLongText }).strict();
/** A fee a customer can owe: integer IDR, never negative. */
const zFee = zMoneyIdr.min(0).max(MAX_LINE_AMOUNT);

/** `repair.ticket_cancelled` v1, before cancellation fees: nothing was charged. */
export const ticketCancelledPayloadV1 = z
  .object({ reason: z.string().trim().min(1).max(MAX_TEXT) })
  .strict();

/**
 * `repair.ticket_cancelled` v2: what the customer pays, and the store's fee in force then, so an
 * owner can see where the person cancelling charged something else.
 */
export const ticketCancelledPayload = ticketCancelledPayloadV1
  .extend({ fee: zFee, standardFee: zFee })
  .strict();

/** Both of a store's cancellation fees, replacing the previous ones. */
export const storeCancelFeesChangedPayload = z
  .object({ beforeWork: zFee, afterWork: zFee })
  .strict();

/** After how many days a ready phone still in the store is flagged, replacing the previous number. */
export const storeUncollectedDaysChangedPayload = z
  .object({ days: z.number().int().min(MIN_UNCOLLECTED_DAYS).max(MAX_UNCOLLECTED_DAYS) })
  .strict();

export const quoteChangeProposedPayload = zQuoteLineDraft
  .extend({ reason: z.string().trim().min(1).max(MAX_TEXT) })
  .strict();

export const quoteChangedPayloadV1 = zQuoteLineDraft
  .extend({
    reason: z.string().trim().min(1).max(MAX_TEXT),
    customerAgreed: z.boolean(),
    /** True when this applies a proposal (lineId is then the proposal's line). */
    fromProposal: z.boolean(),
  })
  .strict();
/**
 * v2: a price change the customer has not agreed to yet waits, like a proposal, and only counts
 * once agreed. In v1 it counted at once, marked unconfirmed.
 */
export const quoteChangedPayload = quoteChangedPayloadV1.extend({ waitsForCustomer: z.boolean() });

export const quoteProposalDeclinedPayload = z.object({ lineId: zUuidV7, note: zLongText }).strict();

export const workPhotosAddedPayload = z
  .object({
    stage: z.enum(WORK_PHOTO_STAGES),
    photos: z.array(zMediaRef).min(1).max(WORK_PHOTOS_MAX),
  })
  .strict();

export const deviceReturnedPayload = z
  .object({ handoverPhoto: zMediaRef, signature: zMediaRef, note: zLongText })
  .strict();

/** Money the customer paid up front: a positive amount when received. */
export const downPaymentReceivedPayload = z.object({ amount: zFee.min(1) }).strict();

/** An owner's correction: the amount it should be (0 removes it), and why. */
export const downPaymentCorrectedPayload = z
  .object({ amount: zFee, reason: z.string().trim().min(1).max(MAX_TEXT) })
  .strict();

export const slipPrintedPayload = z.object({ slip: z.enum(SLIP_KINDS) }).strict();

/** Longest terms a slip prints, all lines together. */
export const MAX_TERMS = 2000;
const zTerms = z.string().trim().min(1).max(MAX_TERMS).nullable();

/**
 * Everything a store's slips print besides the servisan, replacing the previous settings. A logo
 * left out keeps the one already set, so changing the terms needs no copy of the picture's ref.
 */
export const storePrintSettingsChangedPayload = z
  .object({
    name: z.string().trim().min(1).max(100).nullable(),
    address: z.string().trim().max(300),
    phone: z.string().trim().max(100),
    logo: zMediaRef.nullable().optional(),
    logoOnDotMatrix: z.boolean(),
    intakeTerms: zTerms,
    handoverTerms: zTerms,
  })
  .strict();

const NO_UNDO = 'Corrected by a later op on the same ticket; the original stays in the log.';

export const repairOperations: Readonly<Record<string, OperationDeclaration<RepairDatabase>>> = {
  [REPAIR_OP.customerRegistered]: {
    schemaVersion: 1,
    payload: customerRegisteredPayload,
    reversal: 'Corrected by repair.customer_details_corrected; customers are never deleted.',
    apply: customerRegisteredApplier,
    rule: customerRegisteredRule,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_CUSTOMER_ENTITY,
  },
  [REPAIR_OP.customerDetailsCorrected]: {
    schemaVersion: 1,
    payload: customerDetailsCorrectedPayload,
    reversal: 'Reversed by another repair.customer_details_corrected with the previous details.',
    apply: customerDetailsCorrectedApplier,
    rule: customerDetailsCorrectedRule,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_CUSTOMER_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.customer, severity: 'minor' },
  },
  [REPAIR_OP.ticketOpened]: {
    schemaVersion: 3,
    payload: ticketOpenedPayload,
    payloadByVersion: { 1: ticketOpenedPayloadV1, 2: ticketOpenedPayloadV2 },
    reversal:
      'A ticket is never deleted; a mistaken ticket is cancelled (repair.ticket_cancelled).',
    apply: ticketOpenedApplier,
    rule: ticketOpenedRule,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.ticketClaimed]: {
    schemaVersion: 1,
    payload: emptyPayload,
    reversal: 'Reversed by repair.technician_assigned to someone else.',
    apply: ticketClaimedApplier,
    rule: ticketClaimedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.technician, severity: 'minor' },
  },
  [REPAIR_OP.technicianAssigned]: {
    schemaVersion: 1,
    payload: technicianAssignedPayload,
    reversal: 'Reversed by another repair.technician_assigned.',
    apply: technicianAssignedApplier,
    rule: technicianAssignedRule,
    permission: REPAIR_PERMISSION.assign,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.technician, severity: 'minor' },
  },
  [REPAIR_OP.workPhotosAdded]: {
    schemaVersion: 1,
    payload: workPhotosAddedPayload,
    reversal: 'Not reversible: photos are evidence and are never removed.',
    apply: workPhotosAddedApplier,
    rule: workPhotosAddedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.workStarted]: {
    schemaVersion: 1,
    payload: emptyPayload,
    reversal: NO_UNDO,
    apply: workStartedApplier,
    rule: workStartedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.workPaused]: {
    schemaVersion: 1,
    payload: notePayload,
    reversal: 'Reversed by repair.work_started when the parts arrive.',
    apply: workPausedApplier,
    rule: workPausedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.markedRepaired]: {
    schemaVersion: 1,
    payload: notePayload,
    reversal: 'Reversed by repair.work_started (reopening) while the device is still in store.',
    apply: markedRepairedApplier,
    rule: markedRepairedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.ticketCancelled]: {
    schemaVersion: 2,
    payload: ticketCancelledPayload,
    payloadByVersion: { 1: ticketCancelledPayloadV1 },
    reversal: 'Not reversible in slice 1: open a new ticket if the customer changes their mind.',
    apply: ticketCancelledApplier,
    rule: ticketCancelledRule,
    permission: REPAIR_PERMISSION.cancel,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.quoteChangeProposed]: {
    schemaVersion: 1,
    payload: quoteChangeProposedPayload,
    reversal: 'Reversed by repair.quote_proposal_declined.',
    apply: quoteChangeProposedApplier,
    rule: quoteChangeProposedRule,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.quoteChanged]: {
    schemaVersion: 2,
    payload: quoteChangedPayload,
    payloadByVersion: { 1: quoteChangedPayloadV1 },
    reversal: 'Reversed by a further repair.quote_changed line with the opposite amount.',
    apply: quoteChangedApplier,
    rule: quoteChangedRule,
    permission: REPAIR_PERMISSION.quoteChange,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.quoteProposalDeclined]: {
    schemaVersion: 1,
    payload: quoteProposalDeclinedPayload,
    reversal: 'A declined proposal can be proposed again as a new line.',
    apply: quoteProposalDeclinedApplier,
    rule: quoteProposalDeclinedRule,
    permission: REPAIR_PERMISSION.quoteChange,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.ticketRepairTypesChanged]: {
    schemaVersion: 1,
    payload: ticketRepairTypesChangedPayload,
    reversal: 'Reversed by another repair.ticket_repair_types_changed with the previous types.',
    apply: ticketRepairTypesChangedApplier,
    rule: ticketRepairTypesChangedRule,
    // The counter and the technician both set it; the rule checks for either.
    permission: REPAIR_PERMISSION.read,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.repairTypes, severity: 'minor' },
  },
  [REPAIR_OP.deviceReturned]: {
    schemaVersion: 1,
    payload: deviceReturnedPayload,
    reversal: 'Not reversible: the device physically left the store. Warranty opens a new ticket.',
    apply: deviceReturnedApplier,
    rule: deviceReturnedRule,
    permission: REPAIR_PERMISSION.handover,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.location, severity: 'significant' },
  },
  [REPAIR_OP.intakeOptionsChanged]: {
    schemaVersion: 2,
    payload: intakeOptionsChangedPayload,
    payloadByVersion: { 1: intakeOptionsChangedPayloadV1 },
    reversal: 'Reversed by saving the previous list again; tickets keep the labels they recorded.',
    apply: intakeOptionsChangedApplier,
    rule: intakeOptionsChangedRule,
    permission: REPAIR_PERMISSION.manageIntakeOptions,
    entityType: REPAIR_INTAKE_OPTIONS_ENTITY,
    // One list for the whole franchise, on every device, whichever store edited it. No conflict
    // key: the entity holds all five lists, so saving two different lists would read as a clash,
    // and two owners saving the same list is settled by the later save, as for a locale.
    scope: 'tenant',
  },
  [REPAIR_OP.storeIntakeOptionsChanged]: {
    schemaVersion: 2,
    payload: storeIntakeOptionsChangedPayload,
    payloadByVersion: { 1: storeIntakeOptionsChangedPayloadV1 },
    reversal: 'Reversed by showing the items again (another store_intake_options_changed).',
    apply: storeIntakeOptionsChangedApplier,
    rule: ownStoreSettingRule,
    permission: REPAIR_PERMISSION.hideIntakeOptions,
    entityType: REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  },
  [REPAIR_OP.storeCancelFeesChanged]: {
    schemaVersion: 1,
    payload: storeCancelFeesChangedPayload,
    reversal: 'Reversed by saving the previous fees again; cancelled tickets keep the fee charged.',
    apply: storeCancelFeesChangedApplier,
    rule: ownStoreSettingRule,
    permission: REPAIR_PERMISSION.setCancelFees,
    entityType: REPAIR_STORE_CANCEL_FEES_ENTITY,
  },
  [REPAIR_OP.downPaymentReceived]: {
    schemaVersion: 1,
    payload: downPaymentReceivedPayload,
    reversal: 'Corrected by an owner with repair.down_payment_corrected.',
    apply: downPaymentChangedApplier,
    rule: downPaymentReceivedRule,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.downPayment, severity: 'significant' },
  },
  [REPAIR_OP.downPaymentCorrected]: {
    schemaVersion: 1,
    payload: downPaymentCorrectedPayload,
    reversal: 'Reversed by another repair.down_payment_corrected with the previous amount.',
    apply: downPaymentChangedApplier,
    rule: downPaymentCorrectedRule,
    permission: REPAIR_PERMISSION.correctDownPayment,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.downPayment, severity: 'significant' },
  },
  [REPAIR_OP.slipPrinted]: {
    schemaVersion: 1,
    payload: slipPrintedPayload,
    reversal: 'Not reversible: the paper exists. A reprint is logged as another print.',
    apply: slipPrintedApplier,
    rule: slipPrintedRule,
    permission: REPAIR_PERMISSION.read,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.storePrintSettingsChanged]: {
    schemaVersion: 1,
    payload: storePrintSettingsChangedPayload,
    reversal: 'Reversed by saving the previous settings again; printed paper keeps what it said.',
    apply: storePrintSettingsChangedApplier,
    rule: ownStoreSettingRule,
    permission: REPAIR_PERMISSION.setPrintSettings,
    entityType: REPAIR_STORE_PRINT_SETTINGS_ENTITY,
  },
  [REPAIR_OP.storeUncollectedDaysChanged]: {
    schemaVersion: 1,
    payload: storeUncollectedDaysChangedPayload,
    reversal: 'Reversed by saving the previous number of days again.',
    apply: storeUncollectedDaysChangedApplier,
    rule: ownStoreSettingRule,
    permission: REPAIR_PERMISSION.setUncollectedDays,
    entityType: REPAIR_STORE_UNCOLLECTED_ENTITY,
  },
};
