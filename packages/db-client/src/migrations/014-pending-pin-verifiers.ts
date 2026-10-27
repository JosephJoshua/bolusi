// Client migration 14 — keep PIN verifiers that still need uploading across app restarts.
//
// A PIN set, change or reset made on this device is uploaded to the server on the next online
// contact. That queue used to live in memory, so killing the app before the upload lost the new
// verifier for good: the PIN op still synced, but other devices never got the new PIN. One row per
// pending upload, keyed by the op's `verifier_ref`. `salt`, `params` and `hash` are sealed at rest
// like `user_pin_verifiers`. Version 12 belongs to another branch; the runner applies by version.
import type { ClientMigration } from './types.js';

export const pendingPinVerifiersMigration: ClientMigration = {
  version: 14,
  name: 'pending_pin_verifiers',
  statements: [
    `CREATE TABLE pending_pin_verifiers (
  verifier_ref    TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL,
  algo            TEXT NOT NULL CHECK (algo = 'argon2id'),
  salt            TEXT NOT NULL,
  params          TEXT NOT NULL,
  hash            TEXT NOT NULL,
  as_of_timestamp INTEGER NOT NULL,
  as_of_device_id TEXT NOT NULL,
  as_of_seq       INTEGER NOT NULL
)`,
  ],
};
