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
  /** JSON array of `{ item, state, note }`. */
  checklistJson: string;
  /** JSON array of strings (charger, case, SIM…). */
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

export interface RepairDatabase {
  repairCustomers: RepairCustomersTable;
  repairTickets: RepairTicketsTable;
  repairQuoteLines: RepairQuoteLinesTable;
  repairTicketPhotos: RepairTicketPhotosTable;
  repairTicketEvents: RepairTicketEventsTable;
}
