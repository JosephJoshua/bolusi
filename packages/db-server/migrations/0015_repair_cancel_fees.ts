// Owner-only cancelling and discounts, and per-store cancellation fees (product-scope.md,
// "Cancelling a servisan"). Mirrors client migration 11.
//
// Counter staff kept customers' cash by cancelling repairs, so `repair.cancel` leaves the default
// cashier role of every tenant provisioned before this migration (the provisioning matrix no longer
// grants it) and is marked dangerous. Lowering a price is the same opening, so the new
// `repair.discount` goes to owners only. Each store gets one row of fees, and a ticket records the fee a
// cancel charged, the store's fee then, and who cancelled when. Tickets cancelled earlier charged
// nothing: their fees stay null and who/when are filled from their cancel event, as a re-fold does.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const CANCEL = {
  id: 'repair.cancel',
  description:
    'Can cancel a repair and set what the customer pays for it. The device stays in the store until it is handed back.',
};

/** New permissions, granted to the owners' system-default roles. */
const OWNER_PERMISSIONS = [
  {
    id: 'repair.discount',
    action: 'discount',
    description: "Can lower a repair's price with a discount, at intake or later.",
    isDangerous: true,
  },
  {
    id: 'repair.set_cancel_fees',
    action: 'set_cancel_fees',
    description: "Can set the store's cancellation fees, before and after work starts.",
    isDangerous: false,
  },
] as const;
const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_store_cancel_fees (
      store_id    uuid PRIMARY KEY REFERENCES stores(id),
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      before_work bigint NOT NULL,
      after_work  bigint NOT NULL,
      updated_by  uuid NOT NULL,
      updated_at  bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_store_cancel_fees');

  await sql`
    ALTER TABLE repair_tickets
      ADD COLUMN cancel_fee bigint,
      ADD COLUMN cancel_standard_fee bigint,
      ADD COLUMN cancelled_by uuid,
      ADD COLUMN cancelled_at bigint
  `.execute(db);
  await sql`
    UPDATE repair_tickets t SET cancelled_by = e.actor_id, cancelled_at = e.at
    FROM (
      SELECT DISTINCT ON (ticket_id) ticket_id, actor_id, at FROM repair_ticket_events
      WHERE kind = 'repair.ticket_cancelled'
      ORDER BY ticket_id, at DESC, id DESC
    ) e
    WHERE e.ticket_id = t.id AND t.outcome = 'cancelled'
  `.execute(db);

  await sql`
    UPDATE permissions SET is_dangerous = true, description = ${CANCEL.description}
    WHERE id = ${CANCEL.id}
  `.execute(db);
  await sql`
    DELETE FROM role_permissions
    WHERE permission_id = ${CANCEL.id}
      AND role_id IN (SELECT id FROM roles WHERE name = 'cashier' AND is_system_default)
  `.execute(db);

  for (const permission of OWNER_PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'repair', ${permission.action}, 'store',
        ${permission.description}, ${permission.isDangerous})
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
  for (const permission of OWNER_PERMISSIONS) {
    await sql`DELETE FROM role_permissions WHERE permission_id = ${permission.id}`.execute(db);
    await sql`DELETE FROM permissions WHERE id = ${permission.id}`.execute(db);
  }
  await sql`
    INSERT INTO role_permissions (role_id, permission_id, tenant_id)
    SELECT id, ${CANCEL.id}, tenant_id FROM roles WHERE name = 'cashier' AND is_system_default
    ON CONFLICT DO NOTHING
  `.execute(db);
  await sql`
    UPDATE permissions SET is_dangerous = false,
      description = 'Can cancel a repair. The device stays in the store until it is handed back.'
    WHERE id = ${CANCEL.id}
  `.execute(db);
  await sql`
    ALTER TABLE repair_tickets
      DROP COLUMN cancelled_at,
      DROP COLUMN cancelled_by,
      DROP COLUMN cancel_standard_fee,
      DROP COLUMN cancel_fee
  `.execute(db);
  await sql`DROP TABLE repair_store_cancel_fees`.execute(db);
}
