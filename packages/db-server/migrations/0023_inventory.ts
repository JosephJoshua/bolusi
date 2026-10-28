// The `inventory` module: the business's parts list and each store's stock movements
// (product-scope.md, "Parts and stock"). Mirrors client migration 19.
//
// Stock is the sum of a store's movements, never a stored total, so the (store, part) index serves
// every stock read. Permissions are seeded here (the app role cannot write the global table) and
// granted to the system-default roles of existing tenants, as the provisioning matrix grants them
// to new ones (apps/server identity/permissions.ts).
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'inventory.read',
    action: 'read',
    isDangerous: false,
    description: 'Can see the parts list and how many of each part the store has.',
    roles: ['main_owner', 'store_owner', 'cashier', 'technician'],
  },
  {
    id: 'inventory.manage_parts',
    action: 'manage_parts',
    isDangerous: false,
    description: "Can add parts to the business's parts list and edit them.",
    roles: ['main_owner', 'store_owner'],
  },
  {
    id: 'inventory.count',
    action: 'count',
    isDangerous: true,
    description: 'Can set how many of each part the store has, from a count.',
    roles: ['main_owner', 'store_owner'],
  },
  {
    id: 'inventory.use_parts',
    action: 'use_parts',
    isDangerous: false,
    description: 'Can take parts for a servisan being worked on and put unused ones back.',
    roles: ['main_owner', 'store_owner', 'cashier', 'technician'],
  },
  {
    id: 'inventory.correct_use',
    action: 'correct_use',
    isDangerous: true,
    description:
      'Can take or put back parts on a servisan that is no longer being worked on, to correct it.',
    roles: ['main_owner', 'store_owner'],
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE inventory_parts (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      name       text NOT NULL,
      code       text,
      fits       text,
      archived   integer NOT NULL,
      created_by uuid NOT NULL,
      created_at bigint NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'inventory_parts');

  await sql`
    CREATE TABLE inventory_movements (
      id        uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      store_id  uuid NOT NULL REFERENCES stores(id),
      part_id   uuid NOT NULL,
      kind      text NOT NULL,
      qty       integer NOT NULL,
      counted   integer,
      use_kind  text,
      use_id    uuid,
      use_label text,
      note      text,
      user_id   uuid NOT NULL,
      at        bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_movements_part ON inventory_movements (store_id, part_id, at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_inventory_movements_use ON inventory_movements (use_id)`.execute(db);
  await secureTenantTable(db, 'inventory_movements');

  await sql`
    CREATE TABLE inventory_part_fits (
      part_id   uuid NOT NULL,
      position  integer NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      brand     text NOT NULL,
      model     text NOT NULL,
      model_key text NOT NULL,
      PRIMARY KEY (part_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_part_fits_model ON inventory_part_fits (tenant_id, model_key)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_part_fits');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'inventory', ${permission.action}, 'store',
        ${permission.description}, ${permission.isDangerous})
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
    for (const role of permission.roles) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_id, tenant_id)
        SELECT id, ${permission.id}, tenant_id FROM roles WHERE name = ${role} AND is_system_default
        ON CONFLICT DO NOTHING
      `.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const permission of PERMISSIONS) {
    await sql`DELETE FROM role_permissions WHERE permission_id = ${permission.id}`.execute(db);
    await sql`DELETE FROM permissions WHERE id = ${permission.id}`.execute(db);
  }
  await sql`DROP TABLE inventory_part_fits`.execute(db);
  await sql`DROP TABLE inventory_movements`.execute(db);
  await sql`DROP TABLE inventory_parts`.execute(db);
}
