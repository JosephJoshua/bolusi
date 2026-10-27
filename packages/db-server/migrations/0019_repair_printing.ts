// Repair slips: each store's slip header and terms, and the down payment a ticket records
// (product-scope.md, "Printing repair slips"). Mirrors client migration 13.
//
// Two owner permissions: correcting a recorded down payment (dangerous: recording less than was paid
// is how the cash would go missing) and editing what the store's slips print. Tickets opened before
// have no down payment, so the new columns stay null.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

/** New permissions, granted to the owners' system-default roles. */
const OWNER_PERMISSIONS = [
  {
    id: 'repair.correct_down_payment',
    action: 'correct_down_payment',
    description: 'Can change or remove a down payment already recorded on a repair.',
    isDangerous: true,
  },
  {
    id: 'repair.set_print_settings',
    action: 'set_print_settings',
    description: "Can change the store's name, address, logo and terms printed on repair slips.",
    isDangerous: false,
  },
] as const;
const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_store_print_settings (
      store_id           uuid PRIMARY KEY REFERENCES stores(id),
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      name               text,
      address            text NOT NULL,
      phone              text NOT NULL,
      logo_media_id      uuid,
      logo_sha256        text,
      logo_mime          text,
      logo_on_dot_matrix integer NOT NULL,
      intake_terms       text,
      handover_terms     text,
      updated_by         uuid NOT NULL,
      updated_at         bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_store_print_settings');

  await sql`
    ALTER TABLE repair_tickets
      ADD COLUMN down_payment bigint,
      ADD COLUMN down_payment_by uuid,
      ADD COLUMN down_payment_at bigint
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
    ALTER TABLE repair_tickets
      DROP COLUMN down_payment_at,
      DROP COLUMN down_payment_by,
      DROP COLUMN down_payment
  `.execute(db);
  await sql`DROP TABLE repair_store_print_settings`.execute(db);
}
