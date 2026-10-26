// Client migration 9 — the owner-edited intake lists (repair intake-options.ts).
//
// Mirrors server migration 0014. The franchise's lists and each store's hidden items get one row per
// list, and a ticket records the photo angles it asked for (null on tickets opened before, which have
// the six default angles). Versions 7 and 8 belong to other branches; the runner applies by version.
import type { ClientMigration } from './types.js';

export const repairIntakeOptionsMigration: ClientMigration = {
  version: 9,
  name: 'repair_intake_options',
  statements: [
    `CREATE TABLE repair_intake_options (
  tenant_id  TEXT NOT NULL,
  list       TEXT NOT NULL,
  items_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, list)
)`,
    `CREATE TABLE repair_store_intake_options (
  store_id    TEXT NOT NULL,
  list        TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  hidden_json TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (store_id, list)
)`,
    `ALTER TABLE repair_tickets ADD COLUMN intake_photos_json TEXT`,
  ],
};
