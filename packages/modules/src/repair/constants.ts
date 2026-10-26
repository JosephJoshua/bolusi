// Identifiers for the `repair` module: the digital repair ticket (product-scope.md, slice 1).
//
// Op types are past tense and permission ids present tense, as in every other module.

export const REPAIR_MODULE_ID = 'repair' as const;

export const REPAIR_CUSTOMER_ENTITY = 'repair_customer' as const;
export const REPAIR_TICKET_ENTITY = 'repair_ticket' as const;

export const REPAIR_TABLE = {
  customers: 'repair_customers',
  tickets: 'repair_tickets',
  quoteLines: 'repair_quote_lines',
  photos: 'repair_ticket_photos',
  events: 'repair_ticket_events',
} as const;

export const REPAIR_OP = {
  customerRegistered: 'repair.customer_registered',
  customerDetailsCorrected: 'repair.customer_details_corrected',
  ticketOpened: 'repair.ticket_opened',
  ticketClaimed: 'repair.ticket_claimed',
  technicianAssigned: 'repair.technician_assigned',
  workPhotosAdded: 'repair.work_photos_added',
  workStarted: 'repair.work_started',
  workPaused: 'repair.work_paused',
  markedRepaired: 'repair.marked_repaired',
  ticketCancelled: 'repair.ticket_cancelled',
  quoteChangeProposed: 'repair.quote_change_proposed',
  quoteChanged: 'repair.quote_changed',
  quoteProposalDeclined: 'repair.quote_proposal_declined',
  deviceReturned: 'repair.device_returned',
} as const;

/**
 * Store-scoped permissions. The split follows the agreed roles: the cashier does intake, quotes,
 * assignment, cancellation and handover; the technician claims and works tickets and may only
 * PROPOSE quote changes.
 */
export const REPAIR_PERMISSION = {
  read: 'repair.read',
  intake: 'repair.intake',
  work: 'repair.work',
  assign: 'repair.assign',
  quoteChange: 'repair.quote_change',
  cancel: 'repair.cancel',
  handover: 'repair.handover',
} as const;

/** What happened to the repair. Tracked separately from where the device is. */
export const REPAIR_OUTCOMES = [
  'received',
  'in_repair',
  'waiting_for_parts',
  'repaired',
  'cancelled',
] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

/** The outcomes of a repair still being worked on. */
export const IN_PROGRESS_OUTCOMES = [
  'received',
  'in_repair',
  'waiting_for_parts',
] as const satisfies readonly RepairOutcome[];

/** Where the device is. "Cancelled, still in store" is outcome=cancelled + location=in_store. */
export const DEVICE_LOCATIONS = ['in_store', 'returned'] as const;
export type DeviceLocation = (typeof DEVICE_LOCATIONS)[number];

/** The six intake photos every ticket requires (owner decision, 2026-10-25). */
export const INTAKE_PHOTO_SLOTS = ['front', 'back', 'left', 'right', 'top', 'bottom'] as const;
export type IntakePhotoSlot = (typeof INTAKE_PHOTO_SLOTS)[number];

/**
 * The technician's own evidence (owner decision, 2026-10-25): at least one `before` photo to start
 * work and at least one `after` photo each time the repair is marked done. Separate from the six
 * intake photos the counter takes.
 */
export const WORK_PHOTO_STAGES = ['before', 'after'] as const;
export type WorkPhotoStage = (typeof WORK_PHOTO_STAGES)[number];
export const WORK_PHOTOS_MAX = 6;

/** Work photos accumulate across restarts, so each one gets its own slot keyed by its media id. */
export function workPhotoSlot(stage: WorkPhotoStage, mediaId: string): string {
  return `${stage}:${mediaId}`;
}

/** The stage a photo slot belongs to, or null for intake and handover slots. */
export function workPhotoStage(slot: string): WorkPhotoStage | null {
  const stage = slot.slice(0, slot.indexOf(':'));
  return (WORK_PHOTO_STAGES as readonly string[]).includes(stage)
    ? (stage as WorkPhotoStage)
    : null;
}

/** Handover evidence slots. */
export const HANDOVER_PHOTO_SLOTS = ['handover', 'signature'] as const;
export type HandoverPhotoSlot = (typeof HANDOVER_PHOTO_SLOTS)[number];

/** The largest rupiah amount one price line may carry, either way. */
export const MAX_LINE_AMOUNT = 1_000_000_000_000;

export const QUOTE_LINE_KINDS = ['part', 'labour', 'adjustment', 'discount'] as const;
export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

/**
 * `intake` lines are the price the customer left with; `applied` lines are later changes that count
 * toward the total; `proposed` lines are a technician's suggestion awaiting the cashier; `declined`
 * proposals stay visible but never count.
 */
export const QUOTE_LINE_STATUSES = ['intake', 'applied', 'proposed', 'declined'] as const;
export type QuoteLineStatus = (typeof QUOTE_LINE_STATUSES)[number];

export const CHECKLIST_STATES = ['ok', 'issue', 'not_checked'] as const;
export type ChecklistState = (typeof CHECKLIST_STATES)[number];

/** Conflict keys: two devices changing a ticket's outcome or location without seeing each other. */
export const REPAIR_CONFLICT_KEY = {
  outcome: 'repair_ticket.outcome',
  location: 'repair_ticket.location',
  technician: 'repair_ticket.technician',
  customer: 'repair_customer.details',
} as const;
