// Client migration 24 — the customer's status link (product-scope.md, "Customers follow their
// repair online").
//
// Mirrors server migration 0028. A servisan records the code of the link printed on its slip.
// Versions 21 to 23 belong to other branches; the runner applies by version.
import type { ClientMigration } from './types.js';

export const repairStatusLinkMigration: ClientMigration = {
  version: 24,
  name: 'repair_status_link',
  statements: [`ALTER TABLE repair_tickets ADD COLUMN status_code TEXT`],
};
