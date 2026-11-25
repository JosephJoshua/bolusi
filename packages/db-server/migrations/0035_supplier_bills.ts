// Supplier bills ("Tagihan supplier", transfers-bills-returns.md): what a store owes a supplier for
// one nota. Mirrors client migration 33.
//
// A bill carries what each part cost to buy, so it is read only with `purchasing.bills`, granted
// here to the owners' system-default roles of existing tenants as provisioning grants it to new
// ones. What is paid on a bill is money's, never stored on the bill.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSION = {
  id: 'purchasing.bills',
  action: 'bills',
  description:
    "Can record and read the suppliers' bills for the store, with what each part cost to buy.",
} as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE purchasing_bills (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      bill_number text NOT NULL,
      supplier_id uuid NOT NULL,
      order_id    uuid,
      supplier_ref text,
      billed_on   bigint NOT NULL,
      due_on      bigint,
      charges     bigint NOT NULL,
      note        text,
      status      text NOT NULL,
      created_by  uuid NOT NULL,
      created_at  bigint NOT NULL,
      updated_by  uuid NOT NULL,
      updated_at  bigint NOT NULL,
      voided_by   uuid,
      voided_at   bigint,
      void_reason text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_purchasing_bills_store ON purchasing_bills (store_id, status, due_on)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_purchasing_bills_order ON purchasing_bills (order_id) WHERE order_id IS NOT NULL`.execute(
    db,
  );
  await secureTenantTable(db, 'purchasing_bills');

  await sql`
    CREATE TABLE purchasing_bill_lines (
      bill_id    uuid NOT NULL,
      position   integer NOT NULL,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      item_id    uuid NOT NULL,
      item_name  text NOT NULL,
      qty        integer NOT NULL,
      unit_price bigint NOT NULL,
      PRIMARY KEY (bill_id, position)
    )
  `.execute(db);
  await secureTenantTable(db, 'purchasing_bill_lines');

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, 'purchasing', ${PERMISSION.action}, 'store',
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
  await sql`DROP TABLE purchasing_bill_lines`.execute(db);
  await sql`DROP TABLE purchasing_bills`.execute(db);
}
