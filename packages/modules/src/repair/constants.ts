// Identifiers for the `repair` module: the digital repair ticket (product-scope.md, slice 1).
//
// Op types are past tense and permission ids present tense, as in every other module.

export const REPAIR_MODULE_ID = 'repair' as const;

export const REPAIR_CUSTOMER_ENTITY = 'repair_customer' as const;
export const REPAIR_TICKET_ENTITY = 'repair_ticket' as const;
/** The franchise's intake option lists: one entity per tenant, keyed by the tenant id. */
export const REPAIR_INTAKE_OPTIONS_ENTITY = 'repair_intake_options' as const;
/** One store's hidden intake options: one entity per store, keyed by the store id. */
export const REPAIR_STORE_INTAKE_OPTIONS_ENTITY = 'repair_store_intake_options' as const;
/** One store's cancellation fees: one entity per store, keyed by the store id. */
export const REPAIR_STORE_CANCEL_FEES_ENTITY = 'repair_store_cancel_fees' as const;
/** One store's slip header and terms: one entity per store, keyed by the store id. */
export const REPAIR_STORE_PRINT_SETTINGS_ENTITY = 'repair_store_print_settings' as const;
/** When one store flags a phone nobody collected: one entity per store, keyed by the store id. */
export const REPAIR_STORE_UNCOLLECTED_ENTITY = 'repair_store_uncollected' as const;

export const REPAIR_TABLE = {
  customers: 'repair_customers',
  tickets: 'repair_tickets',
  quoteLines: 'repair_quote_lines',
  photos: 'repair_ticket_photos',
  events: 'repair_ticket_events',
  intakeOptions: 'repair_intake_options',
  storeIntakeOptions: 'repair_store_intake_options',
  storeCancelFees: 'repair_store_cancel_fees',
  storePrintSettings: 'repair_store_print_settings',
  storeUncollected: 'repair_store_uncollected',
} as const;

export const REPAIR_OP = {
  customerRegistered: 'repair.customer_registered',
  customerDetailsCorrected: 'repair.customer_details_corrected',
  ticketOpened: 'repair.ticket_opened',
  ticketRepairTypesChanged: 'repair.ticket_repair_types_changed',
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
  /** An owner takes back a handover recorded by mistake: the phone is still in the store. */
  handoverReversed: 'repair.handover_reversed',
  /** The counter corrects what intake wrote down about the phone or the customer. */
  ticketDetailsCorrected: 'repair.ticket_details_corrected',
  intakeOptionsChanged: 'repair.intake_options_changed',
  storeIntakeOptionsChanged: 'repair.store_intake_options_changed',
  storeCancelFeesChanged: 'repair.store_cancel_fees_changed',
  downPaymentReceived: 'repair.down_payment_received',
  downPaymentCorrected: 'repair.down_payment_corrected',
  slipPrinted: 'repair.slip_printed',
  storePrintSettingsChanged: 'repair.store_print_settings_changed',
  storeUncollectedDaysChanged: 'repair.store_uncollected_days_changed',
} as const;

/**
 * Store-scoped permissions. The split follows the agreed roles: the cashier does intake, quotes,
 * assignment and handover; the technician claims and works tickets and may only PROPOSE quote
 * changes; only owners cancel or lower a price (both were how counter staff kept a customer's cash).
 */
export const REPAIR_PERMISSION = {
  read: 'repair.read',
  intake: 'repair.intake',
  work: 'repair.work',
  assign: 'repair.assign',
  quoteChange: 'repair.quote_change',
  cancel: 'repair.cancel',
  /** Lower a price: a discount or a negative adjustment, at intake or later. */
  discount: 'repair.discount',
  handover: 'repair.handover',
  /** Tenant-scoped: edit the intake option lists every store uses. */
  manageIntakeOptions: 'repair.manage_intake_options',
  /** Store-scoped: hide intake options this store does not use. */
  hideIntakeOptions: 'repair.hide_intake_options',
  /** Store-scoped: set what a cancelled servisan costs the customer. */
  setCancelFees: 'repair.set_cancel_fees',
  /** Store-scoped: change or remove a down payment already recorded (owners). */
  correctDownPayment: 'repair.correct_down_payment',
  /** Store-scoped: edit what the store's slips print at the top and in their terms. */
  setPrintSettings: 'repair.set_print_settings',
  /** Store-scoped: set after how many days a phone nobody collected is flagged. */
  setUncollectedDays: 'repair.set_uncollected_days',
  /** Store-scoped: open a warranty claim after the warranty ended, or charge for one (owners). */
  warrantyException: 'repair.warranty_exception',
} as const;

/** The slips a servisan prints: the intake receipt, and the handover slip (pickup or cancel). */
export const SLIP_KINDS = ['intake', 'handover'] as const;
export type SlipKind = (typeof SLIP_KINDS)[number];

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

/**
 * The six intake photos tickets took before the owner could edit the photo list (2026-10-26), and
 * still the default list. A ticket opened before then has exactly these.
 */
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

/**
 * The customer saying on camera that the phone is theirs, asked for by repair types such as an
 * unlock (product-scope.md). Kept with the photos, one slot per clip; the latest one counts.
 */
export const OWNERSHIP_VIDEO_PREFIX = 'ownershipVideo';
/** Up to a minute, at 720p (owner decision, 2026-10-28). */
export const OWNERSHIP_VIDEO_MAX_MS = 60_000;

export function ownershipVideoSlot(mediaId: string): string {
  return `${OWNERSHIP_VIDEO_PREFIX}:${mediaId}`;
}

export function isOwnershipVideoSlot(slot: string): boolean {
  return slot.startsWith(`${OWNERSHIP_VIDEO_PREFIX}:`);
}

/**
 * A repaired or cancelled phone still in the store this many days after it was ready is flagged as
 * not collected (owner decision, 2026-10-28: two months), unless the store set its own number.
 * Flagging only: nothing happens to the phone.
 */
export const DEFAULT_UNCOLLECTED_DAYS = 60;
export const MIN_UNCOLLECTED_DAYS = 1;
export const MAX_UNCOLLECTED_DAYS = 365;

/** Typed digits as a day count within the allowed range; null when empty or out of range. */
export function parseUncollectedDays(text: string): number | null {
  if (text === '') return null;
  const days = Number(text);
  return days >= MIN_UNCOLLECTED_DAYS && days <= MAX_UNCOLLECTED_DAYS ? days : null;
}

/** Handover evidence slots. */
/**
 * How long after the first handover an owner may still take it back: the same working day's
 * mistake, not a way to bring back a phone that went home weeks ago.
 */
export const HANDOVER_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/** A handover line is a check from the owner's list, or an accessory left at intake. */
export const HANDOVER_CHECK_KINDS = ['check', 'accessory'] as const;
export type HandoverCheckKind = (typeof HANDOVER_CHECK_KINDS)[number];
export type ChecklistState = (typeof CHECKLIST_STATES)[number];

/** Conflict keys: two devices changing a ticket's outcome or location without seeing each other. */
export const REPAIR_CONFLICT_KEY = {
  outcome: 'repair_ticket.outcome',
  location: 'repair_ticket.location',
  technician: 'repair_ticket.technician',
  customer: 'repair_customer.details',
  downPayment: 'repair_ticket.down_payment',
  repairTypes: 'repair_ticket.repair_types',
  details: 'repair_ticket.details',
} as const;
