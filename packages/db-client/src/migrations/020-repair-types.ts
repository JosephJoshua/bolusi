// Client migration 20 — repair types on a servisan (product-scope.md, "Warranty, phones not
// collected and customer messages").
//
// Mirrors server migration 0024. A ticket records its repair types with each one's warranty; the
// owner's list of types lives with the other intake lists, so it needs no table of its own. Tickets
// opened before this have none. Versions 18 and 19 belong to other branches; the runner applies by
// version.
import type { ClientMigration } from './types.js';

export const repairTypesMigration: ClientMigration = {
  version: 20,
  name: 'repair_types',
  statements: [
    `ALTER TABLE repair_tickets ADD COLUMN repair_types_json TEXT NOT NULL DEFAULT '[]'`,
  ],
};
