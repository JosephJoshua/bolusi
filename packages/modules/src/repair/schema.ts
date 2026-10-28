// The dialect-neutral shape the `repair` appliers and queries are typed against, as `notes` does
// (see notes/schema.ts): JS types both SQLite and Postgres agree on, cast to each engine's
// generated DB once at registration. No boolean columns — 0/1 integers or text enums instead,
// because op-sqlite refuses boolean binds. Times are ms epoch integers; money is integer IDR.
//
// Column order is the DDL order in both migrations and the manifest (the convergence oracle
// digests in that order).

export interface RepairCustomersTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** Encrypted at rest on the device. */
  name: string;
  /** Encrypted at rest on the device. Optional: customers are never forced to give a number. */
  phone: string | null;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export interface RepairTicketsTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** Human number printed on paper, e.g. `K7Q-0042` (ticket-number.ts). */
  ticketNumber: string;
  customerId: string;
  deviceBrand: string;
  deviceModel: string;
  deviceColor: string;
  deviceImei: string | null;
  /** Unlock code/pattern note. Encrypted at rest on the device. */
  devicePasscode: string | null;
  complaint: string;
  intakeNotes: string;
  /** JSON array of `{ item, label?, state, note }` (no `label` before intake lists were editable). */
  checklistJson: string;
  /** JSON array of `{ item, label }`, or of plain item ids before intake lists were editable. */
  peripheralsJson: string;
  estimatedReadyAt: number | null;
  outcome: string;
  /** Why the outcome is what it is: waiting-for-parts note, cancel reason, repair note. */
  outcomeNote: string | null;
  location: string;
  technicianId: string | null;
  /** Integer IDR: intake lines + applied changes. Proposed/declined lines never count. */
  quoteTotal: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  returnedBy: string | null;
  returnedAt: number | null;
  /**
   * JSON array of `{ slot, label }`: the intake photo angles asked for, in order, as named then.
   * Null for a ticket opened before the list was editable, which has the six default angles.
   */
  intakePhotosJson: string | null;
  /**
   * Integer IDR the customer pays for a cancelled servisan, and the store's fee in force when it was
   * cancelled. Null when not cancelled, or cancelled before fees existed (nothing was charged then).
   */
  cancelFee: number | null;
  cancelStandardFee: number | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
  /** Integer IDR the customer paid up front; null when nothing was. Not a cash ledger. */
  downPayment: number | null;
  downPaymentBy: string | null;
  downPaymentAt: number | null;
  /**
   * When the phone was last ready to collect: marked repaired, or cancelled. Null while it is being
   * worked on (a reopen clears it). A phone still in the store long after this is flagged.
   */
  /** JSON array of the repair types, as recorded: `{ item, label, warrantyDays, needsVideo }`. */
  repairTypesJson: string;
  readyAt: number | null;
}

export interface RepairQuoteLinesTable {
  id: string;
  tenantId: string;
  storeId: string;
  ticketId: string;
  kind: string;
  description: string;
  /** Signed integer IDR (discounts negative). */
  amount: number;
  status: string;
  reason: string | null;
  /** 1 = the customer agreed to this change, 0 = applied without agreement, null = intake/proposal. */
  customerAgreed: number | null;
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
}

export interface RepairTicketPhotosTable {
  ticketId: string;
  slot: string;
  tenantId: string;
  storeId: string;
  mediaId: string;
  /** The signed hash from the op payload, so a pulled ticket can verify downloaded bytes. */
  mediaSha256: string;
  mediaMime: string;
  capturedAt: number;
  addedBy: string;
  addedAt: number;
}

export interface RepairTicketEventsTable {
  /** = the op id. */
  id: string;
  tenantId: string;
  storeId: string;
  ticketId: string;
  /** The op type. */
  kind: string;
  actorId: string;
  at: number;
  /** JSON object with the event's details (note, reason, technician, amount…). */
  detailJson: string;
}

/** The franchise's intake option lists (intake-options.ts), one row per list. */
export interface RepairIntakeOptionsTable {
  tenantId: string;
  list: string;
  /** JSON array of `{ id, label }`, in the order the counter sees them. */
  itemsJson: string;
  updatedBy: string;
  updatedAt: number;
}

/** The intake options one store hides, one row per list. */
export interface RepairStoreIntakeOptionsTable {
  storeId: string;
  list: string;
  tenantId: string;
  /** JSON array of option ids. */
  hiddenJson: string;
  updatedBy: string;
  updatedAt: number;
}

/** One store's cancellation fees, integer IDR. A store that never set them charges nothing. */
export interface RepairStoreCancelFeesTable {
  storeId: string;
  tenantId: string;
  /** Before any work started on the phone. */
  beforeWork: number;
  /** Once a technician has started work on it. */
  afterWork: number;
  updatedBy: string;
  updatedAt: number;
}

/** What one store's slips print at the top and in their terms. A store that never set it prints its own name only. */
export interface RepairStorePrintSettingsTable {
  storeId: string;
  tenantId: string;
  /** The business name printed in large type; null prints the store's name. */
  name: string | null;
  address: string;
  phone: string;
  logoMediaId: string | null;
  logoSha256: string | null;
  logoMime: string | null;
  /** 1 = the dot-matrix prints the logo too (slow, so off unless the owner turns it on). */
  logoOnDotMatrix: number;
  /** One term per line; null prints the app's default terms. */
  intakeTerms: string | null;
  handoverTerms: string | null;
  updatedBy: string;
  updatedAt: number;
}

/** After how many days one store flags a phone nobody collected. A store that never set it uses 60. */
export interface RepairStoreUncollectedTable {
  storeId: string;
  tenantId: string;
  days: number;
  updatedBy: string;
  updatedAt: number;
}

/**
 * The phone catalog (client migration 8, server migration 0016). Not a repair projection: no op
 * writes it, the device downloads it (apps/mobile bootstrap/phone-catalog.ts). Repair reads it to
 * suggest models at intake (device-models.ts). The server's table has the same columns and more.
 */
export interface PhoneModelsTable {
  /** GSMArena's device number. */
  id: number;
  brand: string;
  /** Without the brand: `Galaxy A55`. */
  name: string;
  /** `phone`, `tablet` or `watch`. */
  kind: string;
  announcedYear: number | null;
  /** Comma-separated maker codes, '' when unknown. */
  modelCodes: string;
  /** Null when there is no photo to show. */
  photoSha256: string | null;
  /** The spec sheet as JSON text (`PhoneSpecs`, @bolusi/schemas). */
  specs: string;
  revision: number;
}

export interface RepairDatabase {
  phoneModels: PhoneModelsTable;
  repairCustomers: RepairCustomersTable;
  repairTickets: RepairTicketsTable;
  repairQuoteLines: RepairQuoteLinesTable;
  repairTicketPhotos: RepairTicketPhotosTable;
  repairTicketEvents: RepairTicketEventsTable;
  repairIntakeOptions: RepairIntakeOptionsTable;
  repairStoreIntakeOptions: RepairStoreIntakeOptionsTable;
  repairStoreCancelFees: RepairStoreCancelFeesTable;
  repairStorePrintSettings: RepairStorePrintSettingsTable;
  repairStoreUncollected: RepairStoreUncollectedTable;
}
