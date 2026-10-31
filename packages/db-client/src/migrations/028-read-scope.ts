// Client migration 28 — permission-scoped sync: what this device may read, and its catch-up.
//
// The server sends a device only the ops its people may read, and says with each pull page which
// read permissions it filtered by. The device keeps that set to notice a change: it drops the ops it
// may no longer read, and catches up on older ops it newly may (`backfill`, JSON: the permissions,
// how far the normal pull already was, and the catch-up's own cursor). NULL read set: not known yet,
// which an upgraded device reads as "everything", since older servers sent every op of the store.
import type { ClientMigration } from './types.js';

export const readScopeMigration: ClientMigration = {
  version: 28,
  name: 'read_scope',
  statements: [
    `ALTER TABLE sync_state ADD COLUMN read_set TEXT`,
    `ALTER TABLE sync_state ADD COLUMN backfill TEXT`,
  ],
};
