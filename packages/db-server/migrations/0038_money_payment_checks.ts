// Owners tick non-cash payments off against the bank statement (product-scope.md, "Repair
// payments"). Mirrors client migration 35.
//
// A payment its provider confirmed (Xendit QRIS, recorded by the server) names that provider and
// needs no check. Every other transfer, QRIS or EDC payment carries the latest check: matched, or
// missing with who checked it, until it is voided or checked again. The permission is seeded here
// and granted to the owners' system-default roles of existing tenants, as provisioning grants it
// to new ones.
import { sql, type Kysely } from 'kysely';

const PERMISSION = {
  id: 'money.check_payments',
  action: 'check_payments',
  description:
    'Can tick transfer, QRIS and card payments off against the bank statement, or flag one as missing.',
} as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE money_entries
      ADD COLUMN provider text,
      ADD COLUMN checked_outcome text,
      ADD COLUMN checked_by uuid,
      ADD COLUMN checked_at bigint
  `.execute(db);

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, 'money', ${PERMISSION.action}, 'store', ${PERMISSION.description}, true)
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
  await sql`
    ALTER TABLE money_entries
      DROP COLUMN IF EXISTS checked_at,
      DROP COLUMN IF EXISTS checked_by,
      DROP COLUMN IF EXISTS checked_outcome,
      DROP COLUMN IF EXISTS provider
  `.execute(db);
}
