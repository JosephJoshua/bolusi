// The `repair` projection appliers and table manifests.
//
// Appliers are deterministic fold steps; the engine supplies canonical order and re-folds an
// entity's history when an op arrives out of order. Every ticket table is keyed to the ticket
// entity (`ticket_id`), so a re-fold clears and replays all of them together.
//
// Store safety: every UPDATE is constrained to the op's own store, as in notes, so a device in one
// store cannot sign an op that rewrites another store's ticket.
//
// Appliers never throw on business-rule surprises that concurrency can produce (two devices both
// returning a device, a proposal approved and declined at once). Commands refuse those locally;
// the fold must still accept whatever the server accepted, and the declared conflict keys surface
// the collision for review.
import { sql, type RawBuilder } from 'kysely';

import {
  canonicalizeJcs,
  type JsonValue,
  type ProjectionApplier,
  type ProjectionOperation,
  type ProjectionTableManifest,
} from '@bolusi/core';
import type { AnyMediaRef, MediaRef, VideoRef } from '@bolusi/schemas';

import {
  INTAKE_PHOTO_SLOTS,
  REPAIR_CUSTOMER_ENTITY,
  REPAIR_INTAKE_OPTIONS_ENTITY,
  REPAIR_STORE_CANCEL_FEES_ENTITY,
  REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  REPAIR_STORE_PRINT_SETTINGS_ENTITY,
  REPAIR_STORE_UNCOLLECTED_ENTITY,
  REPAIR_TICKET_ENTITY,
  ownershipVideoSlot,
  workPhotoSlot,
  type DeviceLocation,
  type RepairOutcome,
  type WorkPhotoStage,
} from './constants.js';
import type { RecordedRepairType } from './intake-options.js';
import type { RepairDatabase } from './schema.js';

type Db = Parameters<ProjectionApplier<RepairDatabase>>[0];

// ── table manifests (column order = DDL order) ─────────────────────────────────────────────────

export const repairCustomersTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    name: 'text',
    phone: 'text',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: REPAIR_CUSTOMER_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const repairTicketsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    ticket_number: 'text',
    customer_id: 'text',
    device_brand: 'text',
    device_model: 'text',
    device_color: 'text',
    device_imei: 'text',
    device_passcode: 'text',
    complaint: 'text',
    intake_notes: 'text',
    checklist_json: 'text',
    peripherals_json: 'text',
    estimated_ready_at: 'integer',
    outcome: 'text',
    outcome_note: 'text',
    location: 'text',
    technician_id: 'text',
    quote_total: 'integer',
    created_by: 'text',
    created_at: 'integer',
    updated_at: 'integer',
    returned_by: 'text',
    returned_at: 'integer',
    intake_photos_json: 'text',
    cancel_fee: 'integer',
    cancel_standard_fee: 'integer',
    cancelled_by: 'text',
    cancelled_at: 'integer',
    down_payment: 'integer',
    down_payment_by: 'text',
    down_payment_at: 'integer',
    ready_at: 'integer',
    repair_types_json: 'text',
    claim_of_ticket_id: 'text',
    status_code: 'text',
  },
  primaryKey: ['id'],
  entityType: REPAIR_TICKET_ENTITY,
  entityIdColumn: 'id',
  // 2: a re-fold fills who cancelled and when for tickets cancelled before the columns existed.
  // 3: it fills when each finished phone was ready to collect.
  projectionVersion: 3,
};

export const repairQuoteLinesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    ticket_id: 'text',
    kind: 'text',
    description: 'text',
    amount: 'integer',
    status: 'text',
    reason: 'text',
    customer_agreed: 'integer',
    created_by: 'text',
    created_at: 'integer',
    decided_by: 'text',
    decided_at: 'integer',
    decision_note: 'text',
  },
  primaryKey: ['id'],
  entityType: REPAIR_TICKET_ENTITY,
  entityIdColumn: 'ticket_id',
  projectionVersion: 1,
};

export const repairTicketPhotosTable: ProjectionTableManifest = {
  columns: {
    ticket_id: 'text',
    slot: 'text',
    tenant_id: 'text',
    store_id: 'text',
    media_id: 'text',
    media_sha256: 'text',
    media_mime: 'text',
    captured_at: 'integer',
    added_by: 'text',
    added_at: 'integer',
  },
  primaryKey: ['ticket_id', 'slot'],
  entityType: REPAIR_TICKET_ENTITY,
  entityIdColumn: 'ticket_id',
  projectionVersion: 1,
};

export const repairTicketEventsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    ticket_id: 'text',
    kind: 'text',
    actor_id: 'text',
    at: 'integer',
    detail_json: 'text',
  },
  primaryKey: ['id'],
  entityType: REPAIR_TICKET_ENTITY,
  entityIdColumn: 'ticket_id',
  projectionVersion: 1,
};

export const repairIntakeOptionsTable: ProjectionTableManifest = {
  columns: {
    tenant_id: 'text',
    list: 'text',
    items_json: 'text',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['tenant_id', 'list'],
  entityType: REPAIR_INTAKE_OPTIONS_ENTITY,
  entityIdColumn: 'tenant_id',
  projectionVersion: 1,
};

export const repairStoreIntakeOptionsTable: ProjectionTableManifest = {
  columns: {
    store_id: 'text',
    list: 'text',
    tenant_id: 'text',
    hidden_json: 'text',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['store_id', 'list'],
  entityType: REPAIR_STORE_INTAKE_OPTIONS_ENTITY,
  entityIdColumn: 'store_id',
  projectionVersion: 1,
};

export const repairStoreCancelFeesTable: ProjectionTableManifest = {
  columns: {
    store_id: 'text',
    tenant_id: 'text',
    before_work: 'integer',
    after_work: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['store_id'],
  entityType: REPAIR_STORE_CANCEL_FEES_ENTITY,
  entityIdColumn: 'store_id',
  projectionVersion: 1,
};

export const repairStorePrintSettingsTable: ProjectionTableManifest = {
  columns: {
    store_id: 'text',
    tenant_id: 'text',
    name: 'text',
    address: 'text',
    phone: 'text',
    logo_media_id: 'text',
    logo_sha256: 'text',
    logo_mime: 'text',
    logo_on_dot_matrix: 'integer',
    intake_terms: 'text',
    handover_terms: 'text',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['store_id'],
  entityType: REPAIR_STORE_PRINT_SETTINGS_ENTITY,
  entityIdColumn: 'store_id',
  projectionVersion: 1,
};

export const repairStoreUncollectedTable: ProjectionTableManifest = {
  columns: {
    store_id: 'text',
    tenant_id: 'text',
    days: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['store_id'],
  entityType: REPAIR_STORE_UNCOLLECTED_ENTITY,
  entityIdColumn: 'store_id',
  projectionVersion: 1,
};

// ── payload shapes the appliers read (validated by operations.ts before any fold) ───────────────

interface QuoteLineDraft {
  readonly lineId: string;
  readonly kind: string;
  readonly description: string;
  readonly amount: number;
}

interface RecordedOption {
  readonly item: string;
  readonly label: string | null;
}

/**
 * `repair.ticket_opened` as v3 carries it; v2 has no repair types, and v1 differs besides only in the
 * three fields named below.
 */
export interface TicketOpenedPayload {
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly device: {
    readonly brand: string;
    readonly model: string;
    readonly color: string;
    readonly imei: string | null;
    readonly passcode: string | null;
  };
  readonly complaint: string;
  readonly intakeNotes: string;
  readonly checklist: readonly (RecordedOption & { state: string; note: string })[];
  readonly peripherals: readonly RecordedOption[];
  readonly estimatedReadyAt: number | null;
  readonly quoteLines: readonly QuoteLineDraft[];
  readonly photos: readonly { slot: string; label: string | null; ref: MediaRef }[];
  readonly repairTypes: readonly RecordedRepairType[];
  readonly claimOf: string | null;
  readonly ownershipVideo: VideoRef | null;
}

/** v1: checks without labels, accessories as plain keys, exactly the six default photo angles. */
interface TicketOpenedV1Payload extends Omit<
  TicketOpenedPayload,
  'checklist' | 'peripherals' | 'photos' | 'repairTypes' | 'claimOf' | 'ownershipVideo'
> {
  readonly checklist: readonly { item: string; state: string; note: string }[];
  readonly peripherals: readonly string[];
  readonly photos: Readonly<Record<(typeof INTAKE_PHOTO_SLOTS)[number], MediaRef>>;
}

interface QuoteChangedPayload extends QuoteLineDraft {
  readonly reason: string;
  readonly customerAgreed: boolean;
  readonly fromProposal: boolean;
  /** v2 only; a v1 change counted at once. */
  readonly waitsForCustomer?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

function storeIdOf(op: ProjectionOperation): string {
  if (op.storeId === null) {
    throw new Error(`repair applier: ${op.type} on ${op.entityId} has a null storeId`);
  }
  return op.storeId;
}

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

/**
 * JSON for a projection column, in canonical key order. An op's payload reaches an applier with its
 * keys in whatever order its path produced: the order the command built them on the writing device,
 * sorted on a device that rebuilt it from the signed text or pulled it. Plain `JSON.stringify` would
 * store different bytes for the same op, and devices would not converge.
 */
function canonicalJson(value: unknown): string {
  return canonicalizeJcs(value as JsonValue);
}

async function recordEvent(db: Db, op: ProjectionOperation, detail: object): Promise<void> {
  await db
    .insertInto('repairTicketEvents')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: storeIdOf(op),
      ticketId: op.entityId,
      kind: op.type,
      actorId: op.userId,
      at: op.timestamp,
      detailJson: canonicalJson(detail),
    })
    .execute();
}

async function updateTicket(
  db: Db,
  op: ProjectionOperation,
  values: Partial<{
    outcome: RepairOutcome;
    outcomeNote: string | null;
    location: DeviceLocation;
    technicianId: string;
    returnedBy: string;
    returnedAt: number | RawBuilder<number>;
    cancelFee: number | null;
    cancelStandardFee: number | null;
    cancelledBy: string;
    cancelledAt: number;
    downPayment: number | null;
    downPaymentBy: string;
    downPaymentAt: number;
    readyAt: number | null;
  }>,
): Promise<void> {
  await db
    .updateTable('repairTickets')
    .set({ ...values, updatedAt: op.timestamp })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
}

/** Recompute the total from the lines, so a repeated or concurrent approval never double-counts. */
async function refreshQuoteTotal(db: Db, op: ProjectionOperation): Promise<void> {
  await db
    .updateTable('repairTickets')
    .set({
      quoteTotal: sql<number>`(
        SELECT COALESCE(SUM(amount), 0) FROM repair_quote_lines
        WHERE ticket_id = ${op.entityId} AND status IN ('intake', 'applied')
      )`,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
}

/** One statement for all of an op's photos: every statement costs a few hundred µs on a phone. */
async function insertPhotos(
  db: Db,
  op: ProjectionOperation,
  photos: readonly (readonly [slot: string, ref: AnyMediaRef])[],
): Promise<void> {
  const storeId = storeIdOf(op);
  await db
    .insertInto('repairTicketPhotos')
    .values(
      photos.map(([slot, ref]) => ({
        ticketId: op.entityId,
        slot,
        tenantId: op.tenantId,
        storeId,
        mediaId: ref.mediaId,
        mediaSha256: ref.sha256,
        mediaMime: ref.mime,
        capturedAt: ref.capturedAt,
        addedBy: op.userId,
        addedAt: op.timestamp,
      })),
    )
    // Two devices recording the same handover keep the first (canonical) evidence.
    .onConflict((oc) => oc.columns(['ticketId', 'slot']).doNothing())
    .execute();
}

// ── customers ─────────────────────────────────────────────────────────────────────────────────

export const customerRegisteredApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const payload = payloadOf<{ name: string; phone: string | null }>(op);
  await db
    .insertInto('repairCustomers')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: storeIdOf(op),
      name: payload.name,
      phone: payload.phone,
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .execute();
};

export const customerDetailsCorrectedApplier: ProjectionApplier<RepairDatabase> = async (
  db,
  op,
) => {
  const payload = payloadOf<{ name: string; phone: string | null }>(op);
  await db
    .updateTable('repairCustomers')
    .set({
      name: payload.name,
      phone: payload.phone,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
};

// ── tickets ───────────────────────────────────────────────────────────────────────────────────

/**
 * The rows a v1 ticket has always projected to, unchanged, so tickets opened before the lists were
 * editable need no rebuild and every device keeps converging on the same bytes.
 */
function ticketOpenedRows(op: ProjectionOperation): {
  payload: Omit<
    TicketOpenedPayload,
    'checklist' | 'peripherals' | 'photos' | 'repairTypes' | 'claimOf' | 'ownershipVideo'
  >;
  checklist: readonly object[];
  peripherals: readonly unknown[];
  photos: readonly { slot: string; ref: MediaRef }[];
  intakePhotos: readonly { slot: string; label: string | null }[] | null;
  repairTypes: readonly object[];
  claimOf: string | null;
  ownershipVideo: VideoRef | null;
} {
  switch (op.schemaVersion) {
    case 1: {
      const payload = payloadOf<TicketOpenedV1Payload>(op);
      return {
        payload,
        checklist: payload.checklist,
        peripherals: payload.peripherals,
        photos: INTAKE_PHOTO_SLOTS.map((slot) => ({ slot, ref: payload.photos[slot] })),
        intakePhotos: null,
        repairTypes: [],
        claimOf: null,
        ownershipVideo: null,
      };
    }
    case 2:
    case 3:
    case 4: {
      const payload = payloadOf<TicketOpenedPayload>(op);
      return {
        payload,
        checklist: payload.checklist,
        peripherals: payload.peripherals,
        photos: payload.photos,
        intakePhotos: payload.photos.map(({ slot, label }) => ({ slot, label })),
        // v2 tickets were opened before repair types.
        repairTypes: op.schemaVersion >= 3 ? payload.repairTypes : [],
        claimOf: op.schemaVersion >= 3 ? payload.claimOf : null,
        // Before v4 no repair type asked for a video.
        ownershipVideo: op.schemaVersion >= 4 ? payload.ownershipVideo : null,
      };
    }
    default:
      // Fold every historical version forever; refuse loudly what this build cannot (as notes).
      throw new Error(
        `repair.ticket_opened is at schemaVersion ${op.schemaVersion}, which this applier does not fold`,
      );
  }
}

export const ticketOpenedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const {
    payload,
    checklist,
    peripherals,
    photos,
    intakePhotos,
    repairTypes,
    claimOf,
    ownershipVideo,
  } = ticketOpenedRows(op);
  const storeId = storeIdOf(op);
  await db
    .insertInto('repairTickets')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId,
      ticketNumber: payload.ticketNumber,
      customerId: payload.customerId,
      deviceBrand: payload.device.brand,
      deviceModel: payload.device.model,
      deviceColor: payload.device.color,
      deviceImei: payload.device.imei,
      devicePasscode: payload.device.passcode,
      complaint: payload.complaint,
      intakeNotes: payload.intakeNotes,
      checklistJson: canonicalJson(checklist),
      peripheralsJson: canonicalJson(peripherals),
      estimatedReadyAt: payload.estimatedReadyAt,
      outcome: 'received',
      outcomeNote: null,
      location: 'in_store',
      technicianId: null,
      quoteTotal: payload.quoteLines.reduce((sum, line) => sum + line.amount, 0),
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedAt: op.timestamp,
      returnedBy: null,
      returnedAt: null,
      intakePhotosJson: intakePhotos === null ? null : canonicalJson(intakePhotos),
      cancelFee: null,
      cancelStandardFee: null,
      cancelledBy: null,
      cancelledAt: null,
      downPayment: null,
      downPaymentBy: null,
      downPaymentAt: null,
      readyAt: null,
      repairTypesJson: canonicalJson(repairTypes),
      claimOfTicketId: claimOf,
    })
    .execute();

  if (payload.quoteLines.length > 0) {
    await db
      .insertInto('repairQuoteLines')
      .values(
        payload.quoteLines.map((line) => ({
          id: line.lineId,
          tenantId: op.tenantId,
          storeId,
          ticketId: op.entityId,
          kind: line.kind,
          description: line.description,
          amount: line.amount,
          status: 'intake',
          reason: null,
          customerAgreed: null,
          createdBy: op.userId,
          createdAt: op.timestamp,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        })),
      )
      .execute();
  }

  await insertPhotos(db, op, [
    ...photos.map(({ slot, ref }) => [slot, ref] as const),
    ...(ownershipVideo === null
      ? []
      : [[ownershipVideoSlot(ownershipVideo.mediaId), ownershipVideo] as const]),
  ]);
  await recordEvent(db, op, {});
};

export const ticketClaimedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  await updateTicket(db, op, { technicianId: op.userId });
  await recordEvent(db, op, { technicianId: op.userId });
};

export const ticketRepairTypesChangedApplier: ProjectionApplier<RepairDatabase> = async (
  db,
  op,
) => {
  const { repairTypes } = payloadOf<{ repairTypes: readonly object[] }>(op);
  await db
    .updateTable('repairTickets')
    .set({ repairTypesJson: canonicalJson(repairTypes), updatedAt: op.timestamp })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
  await recordEvent(db, op, { repairTypes });
};

export const technicianAssignedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { technicianId } = payloadOf<{ technicianId: string }>(op);
  await updateTicket(db, op, { technicianId });
  await recordEvent(db, op, { technicianId });
};

export const workPhotosAddedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { stage, photos } = payloadOf<{ stage: WorkPhotoStage; photos: MediaRef[] }>(op);
  if (photos.length > 0) {
    await insertPhotos(
      db,
      op,
      photos.map((photo) => [workPhotoSlot(stage, photo.mediaId), photo] as const),
    );
  }
  await recordEvent(db, op, { stage, count: photos.length });
};

export const workStartedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  // Starting again on a repaired phone (a reopen) means it is no longer waiting to be collected.
  await updateTicket(db, op, { outcome: 'in_repair', outcomeNote: null, readyAt: null });
  await recordEvent(db, op, {});
};

export const workPausedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { note } = payloadOf<{ note: string }>(op);
  await updateTicket(db, op, { outcome: 'waiting_for_parts', outcomeNote: note });
  await recordEvent(db, op, { note });
};

export const markedRepairedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { note } = payloadOf<{ note: string }>(op);
  await updateTicket(db, op, { outcome: 'repaired', outcomeNote: note, readyAt: op.timestamp });
  await recordEvent(db, op, { note });
};

/** v1 cancels predate fees (nothing was charged), so they record no fee. */
export const ticketCancelledApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const {
    reason,
    fee = null,
    standardFee = null,
  } = payloadOf<{
    reason: string;
    fee?: number;
    standardFee?: number;
  }>(op);
  await updateTicket(db, op, {
    outcome: 'cancelled',
    outcomeNote: reason,
    cancelFee: fee,
    cancelStandardFee: standardFee,
    cancelledBy: op.userId,
    cancelledAt: op.timestamp,
    readyAt: op.timestamp,
  });
  await recordEvent(db, op, fee === null ? { reason } : { reason, fee, standardFee });
};

export const quoteChangeProposedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const payload = payloadOf<QuoteLineDraft & { reason: string }>(op);
  await db
    .insertInto('repairQuoteLines')
    .values({
      id: payload.lineId,
      tenantId: op.tenantId,
      storeId: storeIdOf(op),
      ticketId: op.entityId,
      kind: payload.kind,
      description: payload.description,
      amount: payload.amount,
      status: 'proposed',
      reason: payload.reason,
      customerAgreed: null,
      createdBy: op.userId,
      createdAt: op.timestamp,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    })
    .execute();
  await recordEvent(db, op, {
    lineId: payload.lineId,
    description: payload.description,
    amount: payload.amount,
    reason: payload.reason,
  });
};

export const quoteChangedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const payload = payloadOf<QuoteChangedPayload>(op);
  const customerAgreed = payload.customerAgreed ? 1 : 0;
  if (payload.fromProposal) {
    // Approval wins over a concurrent decline: money the cashier agreed with the customer is not
    // silently dropped because another device declined the same proposal offline.
    await db
      .updateTable('repairQuoteLines')
      .set({
        kind: payload.kind,
        description: payload.description,
        amount: payload.amount,
        status: 'applied',
        customerAgreed,
        decidedBy: op.userId,
        decidedAt: op.timestamp,
        decisionNote: payload.reason,
      })
      .where('id', '=', payload.lineId)
      .where('ticketId', '=', op.entityId)
      .where('storeId', '=', storeIdOf(op))
      .where('status', 'in', ['proposed', 'declined'])
      .execute();
  } else {
    // A change still waiting on the customer is decided later, exactly like a proposal.
    const waits = payload.waitsForCustomer === true;
    await db
      .insertInto('repairQuoteLines')
      .values({
        id: payload.lineId,
        tenantId: op.tenantId,
        storeId: storeIdOf(op),
        ticketId: op.entityId,
        kind: payload.kind,
        description: payload.description,
        amount: payload.amount,
        status: waits ? 'proposed' : 'applied',
        reason: payload.reason,
        customerAgreed: waits ? null : customerAgreed,
        createdBy: op.userId,
        createdAt: op.timestamp,
        decidedBy: waits ? null : op.userId,
        decidedAt: waits ? null : op.timestamp,
        decisionNote: null,
      })
      .execute();
  }
  await refreshQuoteTotal(db, op);
  await recordEvent(db, op, {
    lineId: payload.lineId,
    description: payload.description,
    amount: payload.amount,
    reason: payload.reason,
    customerAgreed: payload.customerAgreed,
    fromProposal: payload.fromProposal,
    ...(payload.waitsForCustomer === undefined
      ? {}
      : { waitsForCustomer: payload.waitsForCustomer }),
  });
};

export const quoteProposalDeclinedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { lineId, note } = payloadOf<{ lineId: string; note: string }>(op);
  await db
    .updateTable('repairQuoteLines')
    .set({ status: 'declined', decidedBy: op.userId, decidedAt: op.timestamp, decisionNote: note })
    .where('id', '=', lineId)
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .where('status', '=', 'proposed')
    .execute();
  await recordEvent(db, op, { lineId, note });
};

/**
 * The handover, with the checklist the counter went through (v3) kept in its history entry, where
 * the servisan shows it; the note says why anything was not ticked.
 */
export const deviceReturnedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const payload = payloadOf<{
    handoverPhoto: MediaRef;
    signature: MediaRef;
    note: string;
    checklist?: readonly object[];
  }>(op);
  await updateTicket(db, op, {
    location: 'returned',
    returnedBy: op.userId,
    // A handover taken back and made again keeps the first one's time (handover_reversed).
    returnedAt: sql<number>`coalesce(returned_at, ${op.timestamp})`,
  });
  await insertPhotos(db, op, [
    ['handover', payload.handoverPhoto],
    ['signature', payload.signature],
  ]);
  await recordEvent(
    db,
    op,
    payload.checklist === undefined
      ? { note: payload.note }
      : { note: payload.note, checklist: payload.checklist },
  );
};

/**
 * A handover taken back by an owner: the phone never left. It is in the store again, the handover
 * photo and signature are no longer this servisan's (the next handover takes its own), and the
 * warranty has not started. What was paid stays paid; the history keeps both entries.
 */
export const handoverReversedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { reason } = payloadOf<{ reason: string }>(op);
  // `returnedAt` stays: the warranty counts from the first handover, and so does the undo window.
  await db
    .updateTable('repairTickets')
    .set({ location: 'in_store', returnedBy: null, updatedAt: op.timestamp })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
  await db
    .deleteFrom('repairTicketPhotos')
    .where('ticketId', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .where('slot', 'in', ['handover', 'signature'])
    .execute();
  await recordEvent(db, op, { reason });
};

/** One corrected fact, as the history shows it: what intake wrote and what it is now. */
export interface DetailChange {
  readonly field: string;
  /** Absent for the screen lock, whose code the history never shows. */
  readonly from?: string | null;
  readonly to?: string | null;
}

/**
 * Intake's record corrected. The history entry lists each fact that changed with its old and new
 * value, read from the ticket as it stood, so it cannot claim a "before" that was never there.
 */
export const ticketDetailsCorrectedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const payload = payloadOf<{
    customer?: { name: string; phone: string | null };
    customerId?: string;
    device?: { brand: string; model: string; color: string; imei: string | null };
    passcode?: string | null;
    complaint?: string;
    peripherals?: readonly { item: string; label: string | null }[];
    reason: string;
  }>(op);
  const ticket = await db
    .selectFrom('repairTickets')
    .selectAll()
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .executeTakeFirst();
  if (ticket === undefined) return;
  const changes: DetailChange[] = [];
  const note = (field: string, from: string | null, to: string | null): void => {
    if (from !== to) changes.push({ field, from, to });
  };
  if (payload.customer !== undefined) {
    const customer = await db
      .selectFrom('repairCustomers')
      .select(['name', 'phone'])
      .where('id', '=', ticket.customerId)
      .where('storeId', '=', storeIdOf(op))
      .executeTakeFirst();
    note('customerName', customer?.name ?? null, payload.customer.name);
    note('customerPhone', customer?.phone ?? null, payload.customer.phone);
  }
  if (payload.device !== undefined) {
    note('brand', ticket.deviceBrand, payload.device.brand);
    note('model', ticket.deviceModel, payload.device.model);
    note('color', ticket.deviceColor, payload.device.color);
    note('imei', ticket.deviceImei, payload.device.imei);
  }
  if (payload.passcode !== undefined && payload.passcode !== ticket.devicePasscode) {
    changes.push({ field: 'passcode' });
  }
  if (payload.complaint !== undefined) note('complaint', ticket.complaint, payload.complaint);
  const peripherals =
    payload.peripherals === undefined ? undefined : canonicalJson(payload.peripherals);
  if (peripherals !== undefined && peripherals !== ticket.peripheralsJson) {
    changes.push({ field: 'peripherals' });
  }
  // Without a move, the servisan's own customer is renamed: the rule allowed it only for a
  // customer this servisan alone names.
  if (payload.customer !== undefined && payload.customerId === undefined) {
    await db
      .updateTable('repairCustomers')
      .set({
        name: payload.customer.name,
        phone: payload.customer.phone,
        updatedBy: op.userId,
        updatedAt: op.timestamp,
      })
      .where('id', '=', ticket.customerId)
      .where('storeId', '=', storeIdOf(op))
      .execute();
  }
  await db
    .updateTable('repairTickets')
    .set({
      ...(payload.customerId === undefined ? {} : { customerId: payload.customerId }),
      ...(payload.device === undefined
        ? {}
        : {
            deviceBrand: payload.device.brand,
            deviceModel: payload.device.model,
            deviceColor: payload.device.color,
            deviceImei: payload.device.imei,
          }),
      ...(payload.passcode === undefined ? {} : { devicePasscode: payload.passcode }),
      ...(payload.complaint === undefined ? {} : { complaint: payload.complaint }),
      ...(peripherals === undefined ? {} : { peripheralsJson: peripherals }),
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .execute();
  await recordEvent(db, op, { changes, reason: payload.reason });
};

// ── down payment and printing ─────────────────────────────────────────────────────────────────

/**
 * A down payment received or corrected: either way the ticket now records this amount (0 removes
 * it). Two devices writing one concurrently both stand in the history; the later canonical op wins
 * here, and the shared conflict key puts the clash in front of an owner.
 */
export const downPaymentChangedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { amount, reason } = payloadOf<{ amount: number; reason?: string }>(op);
  await updateTicket(db, op, {
    downPayment: amount === 0 ? null : amount,
    downPaymentBy: op.userId,
    downPaymentAt: op.timestamp,
  });
  await recordEvent(db, op, reason === undefined ? { amount } : { amount, reason });
};

/** A slip printed or shared: only the ticket's history records it, which is what counts reprints. */
export const slipPrintedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { slip } = payloadOf<{ slip: string }>(op);
  await recordEvent(db, op, { slip });
};

/**
 * The customer's status link. The rule allows one per servisan; should two ever fold, the first
 * stays, as it is the one printed first.
 */
export const statusLinkMadeApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const { code } = payloadOf<{ code: string }>(op);
  await db
    .updateTable('repairTickets')
    .set({ statusCode: code })
    .where('id', '=', op.entityId)
    .where('storeId', '=', storeIdOf(op))
    .where('statusCode', 'is', null)
    .execute();
};

// ── intake options ─────────────────────────────────────────────────────────────────────────────

/**
 * A franchise list replaced. The entity is the tenant itself, so an op naming any other entity is
 * not one a real device writes and is ignored: folding it would leave rows a re-fold of the tenant
 * entity could never clear.
 */
export const intakeOptionsChangedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  if (op.entityId !== op.tenantId) return;
  const { list, items } = payloadOf<{ list: string; items: readonly object[] }>(op);
  const values = {
    itemsJson: canonicalJson(items),
    updatedBy: op.userId,
    updatedAt: op.timestamp,
  };
  await db
    .insertInto('repairIntakeOptions')
    .values({ tenantId: op.tenantId, list, ...values })
    .onConflict((oc) => oc.columns(['tenantId', 'list']).doUpdateSet(values))
    .execute();
};

/** A store's hidden items for one list replaced. The entity is the op's own store. */
export const storeIntakeOptionsChangedApplier: ProjectionApplier<RepairDatabase> = async (
  db,
  op,
) => {
  const storeId = storeIdOf(op);
  if (op.entityId !== storeId) return;
  const { list, hidden } = payloadOf<{ list: string; hidden: readonly string[] }>(op);
  const values = {
    hiddenJson: canonicalJson(hidden),
    updatedBy: op.userId,
    updatedAt: op.timestamp,
  };
  await db
    .insertInto('repairStoreIntakeOptions')
    .values({ storeId, list, tenantId: op.tenantId, ...values })
    .onConflict((oc) => oc.columns(['storeId', 'list']).doUpdateSet(values))
    .execute();
};

export const storeCancelFeesChangedApplier: ProjectionApplier<RepairDatabase> = async (db, op) => {
  const storeId = storeIdOf(op);
  if (op.entityId !== storeId) return;
  const { beforeWork, afterWork } = payloadOf<{ beforeWork: number; afterWork: number }>(op);
  const values = { beforeWork, afterWork, updatedBy: op.userId, updatedAt: op.timestamp };
  await db
    .insertInto('repairStoreCancelFees')
    .values({ storeId, tenantId: op.tenantId, ...values })
    .onConflict((oc) => oc.column('storeId').doUpdateSet(values))
    .execute();
};

export const storePrintSettingsChangedApplier: ProjectionApplier<RepairDatabase> = async (
  db,
  op,
) => {
  const storeId = storeIdOf(op);
  if (op.entityId !== storeId) return;
  const payload = payloadOf<{
    name: string | null;
    address: string;
    phone: string;
    logo?: MediaRef | null;
    logoOnDotMatrix: boolean;
    intakeTerms: string | null;
    handoverTerms: string | null;
  }>(op);
  const logo =
    payload.logo === undefined
      ? {}
      : {
          logoMediaId: payload.logo?.mediaId ?? null,
          logoSha256: payload.logo?.sha256 ?? null,
          logoMime: payload.logo?.mime ?? null,
        };
  const values = {
    name: payload.name,
    address: payload.address,
    phone: payload.phone,
    ...logo,
    logoOnDotMatrix: payload.logoOnDotMatrix ? 1 : 0,
    intakeTerms: payload.intakeTerms,
    handoverTerms: payload.handoverTerms,
    updatedBy: op.userId,
    updatedAt: op.timestamp,
  };
  // A logo left out keeps the one already set (none on a store's first settings).
  await db
    .insertInto('repairStorePrintSettings')
    .values({ storeId, tenantId: op.tenantId, ...values })
    .onConflict((oc) => oc.column('storeId').doUpdateSet(values))
    .execute();
};

export const storeUncollectedDaysChangedApplier: ProjectionApplier<RepairDatabase> = async (
  db,
  op,
) => {
  const storeId = storeIdOf(op);
  if (op.entityId !== storeId) return;
  const { days } = payloadOf<{ days: number }>(op);
  const values = { days, updatedBy: op.userId, updatedAt: op.timestamp };
  await db
    .insertInto('repairStoreUncollected')
    .values({ storeId, tenantId: op.tenantId, ...values })
    .onConflict((oc) => oc.column('storeId').doUpdateSet(values))
    .execute();
};
