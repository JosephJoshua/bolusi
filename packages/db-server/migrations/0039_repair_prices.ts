// The repair price list (product-scope.md, "Repair price list"). Mirrors client migration 35.
//
// The business's rows, the phone spellings each row covers (so a servisan's phone finds its prices
// by index), and what each store charges instead. The two permissions are seeded here and granted
// to the existing default owner roles: the main owner edits the list for every store, and a store
// owner sets their own store's prices. Merge after 0037: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'repair.manage_prices',
    action: 'manage_prices',
    scope: 'tenant',
    description: 'Can change the repair price list every store quotes from.',
    roles: ['main_owner'],
  },
  {
    id: 'repair.set_store_prices',
    action: 'set_store_prices',
    scope: 'store',
    description: "Can set the store's own prices instead of the price list's.",
    roles: ['main_owner', 'store_owner'],
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_prices (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      repair_type text NOT NULL,
      quality     text NOT NULL,
      amount      bigint NOT NULL,
      models_json text NOT NULL,
      removed     integer NOT NULL,
      created_at  bigint NOT NULL,
      updated_by  uuid NOT NULL,
      updated_at  bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_prices_type ON repair_prices (tenant_id, repair_type)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_prices');

  await sql`
    CREATE TABLE repair_price_models (
      price_id  uuid NOT NULL,
      model_key text NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      PRIMARY KEY (price_id, model_key)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_price_models_key ON repair_price_models (tenant_id, model_key)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_price_models');

  await sql`
    CREATE TABLE repair_store_prices (
      store_id   uuid NOT NULL REFERENCES stores(id),
      price_id   uuid NOT NULL,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      amount     bigint NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL,
      PRIMARY KEY (store_id, price_id)
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_store_prices');

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
  await sql`DROP TABLE repair_store_prices`.execute(db);
  await sql`DROP TABLE repair_price_models`.execute(db);
  await sql`DROP TABLE repair_prices`.execute(db);
}
