// Supplier payments ("Bayar supplier", transfers-bills-returns.md): what a store paid a supplier,
// for a bill or ahead of one, from its drawer, a bank account or the owner's own money. Mirrors
// client migration 35.
//
// Read with `purchasing.bills`, as bills are. Paying is `purchasing.pay_suppliers`, a dangerous
// owner decision, granted here to the owners' system-default roles of existing tenants as
// provisioning grants it to new ones. A drawer payment's cash side is a money entry, whose table
// needs nothing new.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSION = {
  id: 'purchasing.pay_suppliers',
  action: 'pay_suppliers',
  description:
    "Can pay the store's suppliers from the cash drawer, a store bank account or the owner's own money, and cancel a payment.",
} as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE purchasing_payments (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      supplier_id uuid NOT NULL,
      bill_id     uuid,
      amount      bigint NOT NULL,
      source      text NOT NULL,
      reference   text,
      note        text,
      created_by  uuid NOT NULL,
      created_at  bigint NOT NULL,
      voided_by   uuid,
      voided_at   bigint,
      void_reason text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_purchasing_payments_supplier ON purchasing_payments (store_id, supplier_id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_purchasing_payments_bill ON purchasing_payments (bill_id) WHERE bill_id IS NOT NULL`.execute(
    db,
  );
  await secureTenantTable(db, 'purchasing_payments');

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${PERMISSION.id}, 'purchasing', ${PERMISSION.action}, 'store',
      ${PERMISSION.description}, true)
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
  await sql`DROP TABLE purchasing_payments`.execute(db);
}
