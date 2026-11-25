// Part costs: what each delivery of stock cost a piece to buy (inventory module). Mirrors client
// migration 32.
//
// Costs sit in their own table, read only with `inventory.read_cost` ("Lihat harga beli"), so a
// store device syncs stock moves without what they cost. The permission is seeded here and granted
// to the owners' system-default roles of existing tenants, as provisioning grants it to new ones
// (apps/server identity/permissions.ts). Merge after 0033: the migrator refuses an earlier number
// later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSION = {
  id: 'inventory.read_cost',
  module: 'inventory',
  action: 'read_cost',
  description:
    "Can see what parts cost to buy and the store's average cost of each, and fix a buy price.",
} as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE inventory_costs (
      movement_id uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      item_id     uuid NOT NULL,
      unit_cost   bigint NOT NULL,
      user_id     uuid NOT NULL,
      at          bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_costs_item ON inventory_costs (store_id, item_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_costs');

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, ${PERMISSION.module}, ${PERMISSION.action}, 'store',
      ${PERMISSION.description}, false)
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
  await sql`DROP TABLE inventory_costs`.execute(db);
}
