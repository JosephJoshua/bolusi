// Client migration 13 — repair slips: each store's slip header and terms, and the down payment a
// ticket records (product-scope.md, "Printing repair slips").
//
// Mirrors server migration 0019. Tickets opened before have no down payment, so the new columns stay
// null and nothing needs re-folding. Versions 7, 8, 10 and 12 belong to other branches; the runner
// applies by version.
import type { ClientMigration } from './types.js';

export const repairPrintingMigration: ClientMigration = {
  version: 13,
  name: 'repair_printing',
  statements: [
    `CREATE TABLE repair_store_print_settings (
  store_id           TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  name               TEXT,
  address            TEXT NOT NULL,
  phone              TEXT NOT NULL,
  logo_media_id      TEXT,
  logo_sha256        TEXT,
  logo_mime          TEXT,
  logo_on_dot_matrix INTEGER NOT NULL,
  intake_terms       TEXT,
  handover_terms     TEXT,
  updated_by         TEXT NOT NULL,
  updated_at         INTEGER NOT NULL
)`,
    `ALTER TABLE repair_tickets ADD COLUMN down_payment INTEGER`,
    `ALTER TABLE repair_tickets ADD COLUMN down_payment_by TEXT`,
    `ALTER TABLE repair_tickets ADD COLUMN down_payment_at INTEGER`,
  ],
};
