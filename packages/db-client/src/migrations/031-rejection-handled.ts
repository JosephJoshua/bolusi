// Client migration 31 — a refused change can be marked handled.
//
// Local only, like `sync_status`: the person whose change the server refused says they have dealt
// with it, and it stops asking for attention. Version 30 belongs to another branch; the runner
// applies by version.
import type { ClientMigration } from './types.js';

export const rejectionHandledMigration: ClientMigration = {
  version: 31,
  name: 'rejection_handled',
  statements: [`ALTER TABLE operations ADD COLUMN rejection_handled_at INTEGER`],
};
