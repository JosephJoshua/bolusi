// Client migration 35 — several cash drawers per store (Kas as the shared money ledger).
//
// Mirrors server migration 0037. The money projection rebuild this upgrade triggers (its tables'
// projectionVersion changed) fills `drawer` from the ops: every earlier record is of the main drawer.
import type { ClientMigration } from './types.js';

export const cashDrawersMigration: ClientMigration = {
  version: 35,
  name: 'cash_drawers',
  statements: [
    `ALTER TABLE money_accounts ADD COLUMN role_ids_json TEXT`,
    `ALTER TABLE money_entries ADD COLUMN drawer TEXT`,
    `CREATE INDEX idx_money_entries_store_drawer ON money_entries (store_id, kind, drawer, created_at)`,
  ],
};
