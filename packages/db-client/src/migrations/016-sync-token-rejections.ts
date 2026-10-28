// Client migration 16 — remember how long the server has been refusing this device's token.
//
// A device token never expires, so a server that keeps answering `401 AUTH_TOKEN_INVALID` no longer
// knows this phone (server reset, device row removed, wrong server). The sync loop counts those
// answers and, after enough of them over enough time, stops syncing and asks for re-enrolment. The
// streak lives here so an app restart does not start it over.
import type { ClientMigration } from './types.js';

export const syncTokenRejectionsMigration: ClientMigration = {
  version: 16,
  name: 'sync_token_rejections',
  statements: [
    `ALTER TABLE sync_state ADD COLUMN token_rejected_since INTEGER`,
    `ALTER TABLE sync_state ADD COLUMN token_rejected_count INTEGER NOT NULL DEFAULT 0`,
  ],
};
