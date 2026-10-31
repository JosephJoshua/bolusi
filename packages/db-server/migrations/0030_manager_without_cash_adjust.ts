// Settling a drawer shortage stays with the owners (product-scope.md, "Managers, limits,
// approvals and roles"). Migration 0025 gave the Manajer preset money.adjust_cash, which has no
// limit, so a manager could settle a shortage of any size. Takes it off the preset role only; a
// role the main owner made keeps what they chose.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions
    WHERE permission_id = 'money.adjust_cash'
      AND role_id IN (SELECT id FROM roles WHERE name = 'manager' AND is_system_default)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO role_permissions (role_id, permission_id, tenant_id)
    SELECT r.id, p.id, r.tenant_id
    FROM roles r JOIN permissions p ON p.id = 'money.adjust_cash'
    WHERE r.name = 'manager' AND r.is_system_default
    ON CONFLICT DO NOTHING
  `.execute(db);
}
