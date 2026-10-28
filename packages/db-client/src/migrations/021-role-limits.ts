// Client migration 21 — the limits on a limited role's money decisions (product-scope.md,
// "Managers, limits, approvals and roles").
//
// Mirrors server migration 0025. The bundle carries a limited role's amounts at this device's store;
// the mirror keeps them as JSON, NULL for a role free of limits. The runner applies by version.
import type { ClientMigration } from './types.js';

export const roleLimitsMigration: ClientMigration = {
  version: 21,
  name: 'role_limits',
  statements: [`ALTER TABLE roles_directory ADD COLUMN limits TEXT`],
};
