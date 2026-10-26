// The `repair` op registry: payload schemas, reversal notes, appliers and conflict keys.
//
// All ops are store-scoped (the default). Payloads are strict and carry no floats; money is
// integer IDR. Photos travel as whole signed `mediaRef`s so a pulled ticket can verify the bytes
// it downloads (same reasoning as notes v3).
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zMediaRef, zMoneyIdr, zMsEpoch, zUuid, zUuidV7 } from '@bolusi/schemas';

import {
  customerDetailsCorrectedApplier,
  customerRegisteredApplier,
  deviceReturnedApplier,
  markedRepairedApplier,
  quoteChangedApplier,
  quoteChangeProposedApplier,
  quoteProposalDeclinedApplier,
  technicianAssignedApplier,
  ticketCancelledApplier,
  ticketClaimedApplier,
  ticketOpenedApplier,
  workPausedApplier,
  workPhotosAddedApplier,
  workStartedApplier,
} from './applier.js';
import {
  CHECKLIST_STATES,
  QUOTE_LINE_KINDS,
  REPAIR_CONFLICT_KEY,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_OP,
  REPAIR_PERMISSION,
  REPAIR_TICKET_ENTITY,
  WORK_PHOTO_STAGES,
  WORK_PHOTOS_MAX,
} from './constants.js';
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

export const ticketOpenedPayload = z
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

const emptyPayload = z.object({}).strict();
export const technicianAssignedPayload = z.object({ technicianId: zUuid }).strict();
export const notePayload = z.object({ note: zLongText }).strict();
export const ticketCancelledPayload = z
  .object({ reason: z.string().trim().min(1).max(MAX_TEXT) })
  .strict();

export const quoteChangeProposedPayload = zQuoteLineDraft
  .extend({ reason: z.string().trim().min(1).max(MAX_TEXT) })
  .strict();

export const quoteChangedPayload = zQuoteLineDraft
  .extend({
    reason: z.string().trim().min(1).max(MAX_TEXT),
    customerAgreed: z.boolean(),
    /** True when this applies a technician's proposal (lineId is then the proposal's line). */
    fromProposal: z.boolean(),
  })
  .strict();

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

const NO_UNDO = 'Corrected by a later op on the same ticket; the original stays in the log.';

export const repairOperations: Readonly<Record<string, OperationDeclaration<RepairDatabase>>> = {
  [REPAIR_OP.customerRegistered]: {
    schemaVersion: 1,
    payload: customerRegisteredPayload,
    reversal: 'Corrected by repair.customer_details_corrected; customers are never deleted.',
    apply: customerRegisteredApplier,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_CUSTOMER_ENTITY,
  },
  [REPAIR_OP.customerDetailsCorrected]: {
    schemaVersion: 1,
    payload: customerDetailsCorrectedPayload,
    reversal: 'Reversed by another repair.customer_details_corrected with the previous details.',
    apply: customerDetailsCorrectedApplier,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_CUSTOMER_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.customer, severity: 'minor' },
  },
  [REPAIR_OP.ticketOpened]: {
    schemaVersion: 1,
    payload: ticketOpenedPayload,
    reversal:
      'A ticket is never deleted; a mistaken ticket is cancelled (repair.ticket_cancelled).',
    apply: ticketOpenedApplier,
    permission: REPAIR_PERMISSION.intake,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.ticketClaimed]: {
    schemaVersion: 1,
    payload: emptyPayload,
    reversal: 'Reversed by repair.technician_assigned to someone else.',
    apply: ticketClaimedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.technician, severity: 'minor' },
  },
  [REPAIR_OP.technicianAssigned]: {
    schemaVersion: 1,
    payload: technicianAssignedPayload,
    reversal: 'Reversed by another repair.technician_assigned.',
    apply: technicianAssignedApplier,
    permission: REPAIR_PERMISSION.assign,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.technician, severity: 'minor' },
  },
  [REPAIR_OP.workPhotosAdded]: {
    schemaVersion: 1,
    payload: workPhotosAddedPayload,
    reversal: 'Not reversible: photos are evidence and are never removed.',
    apply: workPhotosAddedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.workStarted]: {
    schemaVersion: 1,
    payload: emptyPayload,
    reversal: NO_UNDO,
    apply: workStartedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.workPaused]: {
    schemaVersion: 1,
    payload: notePayload,
    reversal: 'Reversed by repair.work_started when the parts arrive.',
    apply: workPausedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.markedRepaired]: {
    schemaVersion: 1,
    payload: notePayload,
    reversal: 'Reversed by repair.work_started (reopening) while the device is still in store.',
    apply: markedRepairedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.ticketCancelled]: {
    schemaVersion: 1,
    payload: ticketCancelledPayload,
    reversal: 'Not reversible in slice 1: open a new ticket if the customer changes their mind.',
    apply: ticketCancelledApplier,
    permission: REPAIR_PERMISSION.cancel,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.outcome, severity: 'significant' },
  },
  [REPAIR_OP.quoteChangeProposed]: {
    schemaVersion: 1,
    payload: quoteChangeProposedPayload,
    reversal: 'Reversed by repair.quote_proposal_declined.',
    apply: quoteChangeProposedApplier,
    permission: REPAIR_PERMISSION.work,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.quoteChanged]: {
    schemaVersion: 1,
    payload: quoteChangedPayload,
    reversal: 'Reversed by a further repair.quote_changed line with the opposite amount.',
    apply: quoteChangedApplier,
    permission: REPAIR_PERMISSION.quoteChange,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.quoteProposalDeclined]: {
    schemaVersion: 1,
    payload: quoteProposalDeclinedPayload,
    reversal: 'A declined proposal can be proposed again as a new line.',
    apply: quoteProposalDeclinedApplier,
    permission: REPAIR_PERMISSION.quoteChange,
    entityType: REPAIR_TICKET_ENTITY,
  },
  [REPAIR_OP.deviceReturned]: {
    schemaVersion: 1,
    payload: deviceReturnedPayload,
    reversal: 'Not reversible: the device physically left the store. Warranty opens a new ticket.',
    apply: deviceReturnedApplier,
    permission: REPAIR_PERMISSION.handover,
    entityType: REPAIR_TICKET_ENTITY,
    conflict: { key: REPAIR_CONFLICT_KEY.location, severity: 'significant' },
  },
};
