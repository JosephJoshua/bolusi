// The `inventory` module: the business's items list, its categories and each store's stock movements
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
    scope: 'store',
    isDangerous: false,
    description: 'Can see the parts list and how many of each part the store has.',
    roles: ['main_owner', 'store_owner', 'cashier', 'technician'],
  },
  {
    id: 'inventory.manage_categories',
    action: 'manage_categories',
    scope: 'tenant',
    isDangerous: false,
    description:
      'Can set up the categories of the list, the fields their items fill in and how those items are named.',
    roles: ['main_owner'],
  },
  {
    id: 'inventory.manage_items',
    action: 'manage_items',
    scope: 'store',
    isDangerous: false,
    description:
      "Can add items (spareparts, and later accessories and other goods) to the business's list and edit them.",
    roles: ['main_owner', 'store_owner'],
  },
  {
    id: 'inventory.count',
    action: 'count',
    scope: 'store',
    isDangerous: true,
    description: 'Can set how many of each part the store has, from a count.',
    roles: ['main_owner', 'store_owner'],
  },
  {
    id: 'inventory.use_parts',
    action: 'use_parts',
    scope: 'store',
    isDangerous: false,
    description: 'Can take parts for a servisan being worked on and put unused ones back.',
    roles: ['main_owner', 'store_owner', 'cashier', 'technician'],
  },
  {
    id: 'inventory.correct_use',
    action: 'correct_use',
    scope: 'store',
    isDangerous: true,
    description:
      'Can take or put back parts on a servisan that is no longer being worked on, to correct it.',
    roles: ['main_owner', 'store_owner'],
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE inventory_items (
      id           uuid PRIMARY KEY,
      tenant_id    uuid NOT NULL REFERENCES tenants(id),
      name         text NOT NULL,
      name_auto    integer NOT NULL,
      code         text,
      barcode      text,
      category_id  uuid,
      field_values text NOT NULL,
      fits         text,
      archived     integer NOT NULL,
      created_by   uuid NOT NULL,
      created_at   bigint NOT NULL,
      updated_by   uuid NOT NULL,
      updated_at   bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_items_category ON inventory_items (tenant_id, category_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_items');

  await sql`
    CREATE TABLE inventory_categories (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      name        text NOT NULL,
      is_part     integer NOT NULL,
      fields      text NOT NULL,
      name_format text NOT NULL,
      archived    integer NOT NULL,
      created_by  uuid NOT NULL,
      created_at  bigint NOT NULL,
      updated_by  uuid NOT NULL,
      updated_at  bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'inventory_categories');

  await sql`
    CREATE TABLE inventory_item_facets (
      item_id   uuid NOT NULL,
      position  integer NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      facet     text NOT NULL,
      value     text NOT NULL,
      value_key text NOT NULL,
      PRIMARY KEY (item_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_item_facets_value ON inventory_item_facets (tenant_id, facet, value_key)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_item_facets');

  await sql`
    CREATE TABLE inventory_movements (
      id        uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      store_id  uuid NOT NULL REFERENCES stores(id),
      item_id   uuid NOT NULL,
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
  await sql`CREATE INDEX idx_inventory_movements_part ON inventory_movements (store_id, item_id, at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_inventory_movements_use ON inventory_movements (use_id)`.execute(db);
  await secureTenantTable(db, 'inventory_movements');

  await sql`
    CREATE TABLE inventory_item_fits (
      item_id   uuid NOT NULL,
      position  integer NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      brand     text NOT NULL,
      model     text NOT NULL,
      model_key text NOT NULL,
      PRIMARY KEY (item_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_item_fits_model ON inventory_item_fits (tenant_id, model_key)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_item_fits');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'inventory', ${permission.action}, ${permission.scope},
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
  await sql`DROP TABLE inventory_item_facets`.execute(db);
  await sql`DROP TABLE inventory_categories`.execute(db);
  await sql`DROP TABLE inventory_item_fits`.execute(db);
  await sql`DROP TABLE inventory_movements`.execute(db);
  await sql`DROP TABLE inventory_items`.execute(db);
}
