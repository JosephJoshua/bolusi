// Client migration 4 — the `repair` module projections (digital repair ticket, slice 1).
//
// Mirrors server migration 0012. Customer name/phone, the device passcode and event details are
// encrypted at rest by the column-encryption plugin, so they stay TEXT here. Money is integer IDR;
// times are ms epoch.
import type { ClientMigration } from './types.js';

export const repairMigration: ClientMigration = {
  version: 4,
  name: 'repair',
  statements: [
    `CREATE TABLE repair_customers (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
    `CREATE TABLE repair_tickets (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  store_id           TEXT NOT NULL,
  ticket_number      TEXT NOT NULL,
  customer_id        TEXT NOT NULL,
  device_brand       TEXT NOT NULL,
  device_model       TEXT NOT NULL,
  device_color       TEXT NOT NULL,
  device_imei        TEXT,
  device_passcode    TEXT,
  complaint          TEXT NOT NULL,
  intake_notes       TEXT NOT NULL,
  checklist_json     TEXT NOT NULL,
  peripherals_json   TEXT NOT NULL,
  estimated_ready_at INTEGER,
  outcome            TEXT NOT NULL,
  outcome_note       TEXT,
  location           TEXT NOT NULL,
  technician_id      TEXT,
  quote_total        INTEGER NOT NULL,
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  returned_by        TEXT,
  returned_at        INTEGER
)`,
    `CREATE INDEX idx_repair_tickets_store_created ON repair_tickets (store_id, created_at)`,
    `CREATE INDEX idx_repair_tickets_customer ON repair_tickets (customer_id)`,
    `CREATE INDEX idx_repair_tickets_number ON repair_tickets (ticket_number)`,
    `CREATE TABLE repair_quote_lines (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  store_id        TEXT NOT NULL,
  ticket_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,
  customer_agreed INTEGER,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  decided_by      TEXT,
  decided_at      INTEGER,
  decision_note   TEXT
)`,
    `CREATE INDEX idx_repair_quote_lines_ticket ON repair_quote_lines (ticket_id)`,
    `CREATE TABLE repair_ticket_photos (
  ticket_id    TEXT NOT NULL,
  slot         TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  media_id     TEXT NOT NULL,
  media_sha256 TEXT NOT NULL,
  media_mime   TEXT NOT NULL,
  captured_at  INTEGER NOT NULL,
  added_by     TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, slot)
)`,
    `CREATE TABLE repair_ticket_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  store_id    TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  at          INTEGER NOT NULL,
  detail_json TEXT NOT NULL
)`,
    `CREATE INDEX idx_repair_ticket_events_ticket ON repair_ticket_events (ticket_id, at)`,
  ],
};
