// Client migration 17 — flagging phones nobody collected (product-scope.md, "Warranty, phones not
// collected and customer messages").
//
// Mirrors server migration 0021. A ticket records when its phone was last ready to collect, and each
// store may set after how many days such a phone is flagged. The repair projection rebuild this
// upgrade triggers (the table set and projectionVersion changed) fills `ready_at` from the ops.
// Version 16 belongs to another branch; the runner applies by version.
import type { ClientMigration } from './types.js';

export const repairUncollectedMigration: ClientMigration = {
  version: 17,
  name: 'repair_uncollected',
  statements: [
    `CREATE TABLE repair_store_uncollected (
  store_id   TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  days       INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
    `ALTER TABLE repair_tickets ADD COLUMN ready_at INTEGER`,
  ],
};
