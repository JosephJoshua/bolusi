// The `purchasing` module: suppliers, orders to them per store, and what arrived on each
// (product-scope.md, "Purchasing"). Mirrors client migration 29.
//
// What an order has received is the sum of its receipt lines, never stored on the order, so two
// phones receiving one order offline never overwrite each other. Permissions are seeded here and
// granted to the owners' system-default roles of existing tenants, as provisioning grants them to
// new ones (apps/server identity/permissions.ts). Merge after 0031: the migrator refuses an earlier
// number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'purchasing.buy',
    module: 'purchasing',
    action: 'buy',
    description:
      "Can keep the business's suppliers, order parts from them for the store and receive what arrives.",
  },
  {
    id: 'inventory.receive',
    module: 'inventory',
    action: 'receive',
    description: "Can add parts that arrived on a supplier order to the store's stock.",
  },
] as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE purchasing_suppliers (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      name       text NOT NULL,
      phone      text,
      note       text,
      archived   integer NOT NULL,
      created_by uuid NOT NULL,
      created_at bigint NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'purchasing_suppliers');

  await sql`
    CREATE TABLE purchasing_orders (
      id            uuid PRIMARY KEY,
      tenant_id     uuid NOT NULL REFERENCES tenants(id),
      store_id      uuid NOT NULL REFERENCES stores(id),
      order_number  text NOT NULL,
      supplier_id   uuid NOT NULL,
      status        text NOT NULL,
      note          text,
      created_by    uuid NOT NULL,
      created_at    bigint NOT NULL,
      ordered_by    uuid,
      ordered_at    bigint,
      cancelled_by  uuid,
      cancelled_at  bigint,
      cancel_reason text,
      updated_at    bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_purchasing_orders_store ON purchasing_orders (store_id, status, created_at)`.execute(
    db,
  );
  await secureTenantTable(db, 'purchasing_orders');

  await sql`
    CREATE TABLE purchasing_order_lines (
      order_id  uuid NOT NULL,
      position  integer NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      item_id   uuid NOT NULL,
      item_name text NOT NULL,
      qty       integer NOT NULL,
      PRIMARY KEY (order_id, position)
    )
  `.execute(db);
  await secureTenantTable(db, 'purchasing_order_lines');

  await sql`
    CREATE TABLE purchasing_receipts (
      id        uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      store_id  uuid NOT NULL REFERENCES stores(id),
      order_id  uuid NOT NULL,
      note      text,
      user_id   uuid NOT NULL,
      at        bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_purchasing_receipts_order ON purchasing_receipts (order_id, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'purchasing_receipts');

  await sql`
    CREATE TABLE purchasing_receipt_lines (
      receipt_id uuid NOT NULL,
      position   integer NOT NULL,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      order_id   uuid NOT NULL,
      item_id    uuid NOT NULL,
      qty        integer NOT NULL,
      PRIMARY KEY (receipt_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_purchasing_receipt_lines_order ON purchasing_receipt_lines (order_id, item_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'purchasing_receipt_lines');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, ${permission.module}, ${permission.action}, 'store',
        ${permission.description}, false)
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
    for (const role of OWNER_ROLES) {
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
  await sql`DROP TABLE purchasing_receipt_lines`.execute(db);
  await sql`DROP TABLE purchasing_receipts`.execute(db);
  await sql`DROP TABLE purchasing_order_lines`.execute(db);
  await sql`DROP TABLE purchasing_orders`.execute(db);
  await sql`DROP TABLE purchasing_suppliers`.execute(db);
}
