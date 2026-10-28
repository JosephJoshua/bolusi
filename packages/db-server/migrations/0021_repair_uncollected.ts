// Flagging phones nobody collected (product-scope.md, "Warranty, phones not collected and customer
// messages"). Mirrors client migration 17.
//
// A ticket records when its phone was last ready to collect (marked repaired, or cancelled), and each
// store may set after how many days such a phone is flagged; until then it is 60. Tickets finished
// before this migration get the time of their latest repaired or cancel event, as a re-fold does.
// Setting the number is an owner's.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSION = {
  id: 'repair.set_uncollected_days',
  action: 'set_uncollected_days',
  description:
    'Can set after how many days a repaired or cancelled phone nobody collected is flagged.',
} as const;
const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_store_uncollected (
      store_id   uuid PRIMARY KEY REFERENCES stores(id),
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      days       integer NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_store_uncollected');

  await sql`ALTER TABLE repair_tickets ADD COLUMN ready_at bigint`.execute(db);
  await sql`
    UPDATE repair_tickets t SET ready_at = e.at
    FROM (
      SELECT ticket_id, max(at) AS at FROM repair_ticket_events
      WHERE kind IN ('repair.marked_repaired', 'repair.ticket_cancelled')
      GROUP BY ticket_id
    ) e
    WHERE e.ticket_id = t.id AND t.outcome IN ('repaired', 'cancelled')
  `.execute(db);

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, 'repair', ${PERMISSION.action}, 'store', ${PERMISSION.description}, false)
    ON CONFLICT (id) DO UPDATE SET
      module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
      description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
  `.execute(db);
  for (const role of OWNER_ROLES) {
    await sql`
      INSERT INTO role_permissions (role_id, permission_id, tenant_id)
      SELECT id, ${PERMISSION.id}, tenant_id FROM roles WHERE name = ${role} AND is_system_default
      ON CONFLICT DO NOTHING
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM role_permissions WHERE permission_id = ${PERMISSION.id}`.execute(db);
  await sql`DELETE FROM permissions WHERE id = ${PERMISSION.id}`.execute(db);
  await sql`ALTER TABLE repair_tickets DROP COLUMN ready_at`.execute(db);
  await sql`DROP TABLE repair_store_uncollected`.execute(db);
}
