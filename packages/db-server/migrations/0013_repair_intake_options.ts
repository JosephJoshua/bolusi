// The owner-edited intake lists (repair intake-options.ts). Mirrors client migration 9.
//
// One row per franchise list and one per list a store hides items from; a ticket records the photo
// angles it asked for (null on tickets opened before, which have the six default angles). The two
// new permissions are seeded here like 0012's, and granted to the existing default owner roles so a
// tenant provisioned before this migration can use them: main_owner holds every permission (02 §12)
// and store_owner every store-scoped one.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'repair.manage_intake_options',
    action: 'manage_intake_options',
    scope: 'tenant',
    description:
      'Can change the checks, accessories, photos, brands and ready-by choices every store uses at intake.',
    roles: ['main_owner'],
  },
  {
    id: 'repair.hide_intake_options',
    action: 'hide_intake_options',
    scope: 'store',
    description:
      "Can hide intake checks, accessories, photos, brands and ready-by choices the store doesn't use.",
    roles: ['main_owner', 'store_owner'],
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_intake_options (
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      list       text NOT NULL,
      items_json text NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, list)
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_intake_options');

  await sql`
    CREATE TABLE repair_store_intake_options (
      store_id    uuid NOT NULL REFERENCES stores(id),
      list        text NOT NULL,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      hidden_json text NOT NULL,
      updated_by  uuid NOT NULL,
      updated_at  bigint NOT NULL,
      PRIMARY KEY (store_id, list)
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_store_intake_options');

  await sql`ALTER TABLE repair_tickets ADD COLUMN intake_photos_json text`.execute(db);

  for (const p of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${p.id}, 'repair', ${p.action}, ${p.scope}, ${p.description}, false)
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
    for (const role of p.roles) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_id, tenant_id)
        SELECT id, ${p.id}, tenant_id FROM roles WHERE name = ${role} AND is_system_default
        ON CONFLICT DO NOTHING
      `.execute(db);
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of PERMISSIONS) {
    await sql`DELETE FROM role_permissions WHERE permission_id = ${p.id}`.execute(db);
    await sql`DELETE FROM permissions WHERE id = ${p.id}`.execute(db);
  }
  await sql`ALTER TABLE repair_tickets DROP COLUMN intake_photos_json`.execute(db);
  await sql`DROP TABLE repair_store_intake_options`.execute(db);
  await sql`DROP TABLE repair_intake_options`.execute(db);
}
