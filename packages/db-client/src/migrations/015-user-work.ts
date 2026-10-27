// Client migration 15 — each user's in-progress work, kept across app restarts.
//
// One row per user holding their open drafts and where they were in the app, written through by
// `SessionManager` (core auth/work-store.ts) and read back on that user's next PIN unlock. `work` is
// sealed by the column cipher: drafts can carry customer names, phones and device passcodes.
// Device-local only; nothing here is synced. Versions 10, 12, 13 and 14 belong to other branches.
import type { ClientMigration } from './types.js';

export const userWorkMigration: ClientMigration = {
  version: 15,
  name: 'user_work',
  statements: [
    `CREATE TABLE user_work (
  user_id    TEXT PRIMARY KEY,
  work       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  ],
};
