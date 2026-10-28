// Managers and the limits on owners' money decisions (product-scope.md, "Managers, limits,
// approvals and roles"). Mirrors client migration 23. 0025 and 0026 belong to other branches and
// must be merged first.
//
// A role is either free of limits (the owners) or limited; a limited role's amounts are set per
// store and per kind, and a kind with no row is Rp 0 there. Every business gets the Manajer role:
// the counter's and the technician's work plus the owners' decisions, limited. Setting the limits
// is a new store permission the owners' roles get.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const LIMIT_MANAGE = {
  id: 'auth.limit_manage',
  action: 'limit_manage',
  description:
    'Can set how much a limited role, such as a manager, may discount, refund or let a customer owe at the store.',
} as const;
const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

/** apps/server identity/permissions.ts MANAGER_PERMS, as of this migration. */
const MANAGER_PERMISSIONS = [
  'auth.pin_change',
  'platform.set_locale',
  'repair.read',
  'repair.intake',
  'repair.work',
  'repair.assign',
  'repair.quote_change',
  'repair.handover',
  'repair.cancel',
  'repair.discount',
  'repair.correct_down_payment',
  'repair.warranty_exception',
  'inventory.read',
  'inventory.use_parts',
  'inventory.correct_use',
  'inventory.count',
  'money.read',
  'money.receive',
  'money.move_cash',
  'money.count_cash',
  'money.adjust_cash',
  'money.refund',
  'money.void_payment',
  'money.extend_credit',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE roles ADD COLUMN limited boolean NOT NULL DEFAULT false`.execute(db);

  await sql`
    CREATE TABLE role_limits (
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      role_id   uuid NOT NULL REFERENCES roles(id),
      store_id  uuid NOT NULL REFERENCES stores(id),
      kind      text NOT NULL CHECK (kind IN ('priceDrop', 'refund', 'credit')),
      amount    bigint NOT NULL CHECK (amount >= 0),
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (role_id, store_id, kind)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_role_limits_store ON role_limits (store_id)`.execute(db);
  await secureTenantTable(db, 'role_limits');

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${LIMIT_MANAGE.id}, 'auth', ${LIMIT_MANAGE.action}, 'store',
      ${LIMIT_MANAGE.description}, true)
    ON CONFLICT (id) DO UPDATE SET
      module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
      description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
  `.execute(db);
  for (const role of OWNER_ROLES) {
    await sql`
      INSERT INTO role_permissions (role_id, permission_id, tenant_id)
      SELECT id, ${LIMIT_MANAGE.id}, tenant_id FROM roles WHERE name = ${role} AND is_system_default
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  // One Manajer per business that has none yet. The id is a fresh v4: role ids are opaque.
  await sql`
    INSERT INTO roles (id, tenant_id, name, scope_type, is_system_default, limited, created_at)
    SELECT gen_random_uuid(), t.id, 'manager', 'store', true, true,
      (extract(epoch from now()) * 1000)::bigint
    FROM tenants t
    WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.name = 'manager')
  `.execute(db);
  for (const permission of MANAGER_PERMISSIONS) {
    // Only ids this database knows: a module's permission arrives with its own migration.
    await sql`
      INSERT INTO role_permissions (role_id, permission_id, tenant_id)
      SELECT r.id, p.id, r.tenant_id
      FROM roles r JOIN permissions p ON p.id = ${permission}
      WHERE r.name = 'manager' AND r.is_system_default
      ON CONFLICT DO NOTHING
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions WHERE role_id IN
      (SELECT id FROM roles WHERE name = 'manager' AND is_system_default)
  `.execute(db);
  await sql`DELETE FROM roles WHERE name = 'manager' AND is_system_default`.execute(db);
  await sql`DELETE FROM role_permissions WHERE permission_id = ${LIMIT_MANAGE.id}`.execute(db);
  await sql`DELETE FROM permissions WHERE id = ${LIMIT_MANAGE.id}`.execute(db);
  await sql`DROP TABLE role_limits`.execute(db);
  await sql`ALTER TABLE roles DROP COLUMN limited`.execute(db);
}
