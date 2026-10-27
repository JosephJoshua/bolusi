// Client migration 11 — per-store cancellation fees, and what each cancel charged.
//
// Mirrors server migration 0016. Each store gets one row of fees, and a ticket records the fee a
// cancel charged, the store's fee then, and who cancelled when. Tickets cancelled earlier charged
// nothing: their fees stay null, and the repair projection rebuild this upgrade triggers (the table
// set and projectionVersion changed) refills who/when from their cancel ops.
// Version 10 belongs to another branch; the runner applies by version.
import type { ClientMigration } from './types.js';

export const repairCancelFeesMigration: ClientMigration = {
  version: 11,
  name: 'repair_cancel_fees',
  statements: [
    `CREATE TABLE repair_store_cancel_fees (
  store_id    TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  before_work INTEGER NOT NULL,
  after_work  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
    `ALTER TABLE repair_tickets ADD COLUMN cancel_fee INTEGER`,
    `ALTER TABLE repair_tickets ADD COLUMN cancel_standard_fee INTEGER`,
    `ALTER TABLE repair_tickets ADD COLUMN cancelled_by TEXT`,
    `ALTER TABLE repair_tickets ADD COLUMN cancelled_at INTEGER`,
  ],
};
