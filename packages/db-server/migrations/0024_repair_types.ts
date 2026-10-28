// Repair types and warranty claims on a servisan (product-scope.md, "Warranty, phones not
// collected and customer messages"). Mirrors client migration 20.
//
// A ticket records its repair types with each one's warranty; the owner's list of types lives with
// the other intake lists, so it needs no table of its own. Tickets opened before this have none. A
// warranty claim is a new ticket that names the one it claims on; a claim after the warranty ended,
// or one the customer pays for, is an owner's call. 0022 and 0023 belong to other branches and
// must be merged first.
import { sql, type Kysely } from 'kysely';

const PERMISSION = {
  id: 'repair.warranty_exception',
  action: 'warranty_exception',
  description: 'Can open a warranty claim after the warranty ended, or charge for a claim.',
} as const;
const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE repair_tickets ADD COLUMN repair_types_json text NOT NULL DEFAULT '[]'`.execute(
    db,
  );
  await sql`ALTER TABLE repair_tickets ADD COLUMN claim_of_ticket_id uuid`.execute(db);
  await sql`CREATE INDEX idx_repair_tickets_claim_of ON repair_tickets (claim_of_ticket_id)`.execute(
    db,
  );

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, 'repair', ${PERMISSION.action}, 'store', ${PERMISSION.description}, true)
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
  await sql`DROP INDEX idx_repair_tickets_claim_of`.execute(db);
  await sql`ALTER TABLE repair_tickets DROP COLUMN claim_of_ticket_id`.execute(db);
  await sql`ALTER TABLE repair_tickets DROP COLUMN repair_types_json`.execute(db);
}
