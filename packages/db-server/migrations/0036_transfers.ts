// Parts sent between stores (product-scope.md, "Transfers between stores"). Mirrors client
// migration 33.
//
// A transfer belongs to the store that sent it, and its arrivals to the store that received them,
// but both stores must see all of it. `operations.other_store_id` is the second store an op reaches
// (`OperationDeclaration.otherStore`): pulls serve a device its own store's ops, the tenant's, and
// those naming its store there.
//
// Permissions are seeded and granted to the owners' system-default roles of existing tenants, and
// the Manajer preset gets "Kirim sparepart antar toko" (send and receive), as provisioning gives new
// tenants. Merge after 0035: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'inventory.transfer',
    action: 'transfer',
    isDangerous: false,
    description:
      "Can send parts from the store's stock to another store, and cancel a send before anything arrives.",
  },
  {
    id: 'inventory.settle_transfer',
    action: 'settle_transfer',
    isDangerous: true,
    description:
      'Can settle parts a transfer from the store never delivered: back into stock, or written off with a reason.',
  },
] as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;
const MANAGER_PERMISSIONS = ['inventory.transfer', 'inventory.receive'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE operations ADD COLUMN other_store_id uuid REFERENCES stores(id)`.execute(
    db,
  );
  await sql`
    CREATE INDEX idx_operations_other_store ON operations (tenant_id, other_store_id, server_seq)
    WHERE other_store_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE inventory_transfers (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      store_id        uuid NOT NULL REFERENCES stores(id),
      to_store_id     uuid NOT NULL REFERENCES stores(id),
      transfer_number text NOT NULL,
      note            text,
      sent_by         uuid NOT NULL,
      sent_at         bigint NOT NULL,
      cancelled_by    uuid,
      cancelled_at    bigint,
      cancel_reason   text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_transfers_from ON inventory_transfers (store_id, sent_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_inventory_transfers_to ON inventory_transfers (to_store_id, sent_at)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_transfers');

  await sql`
    CREATE TABLE inventory_transfer_lines (
      transfer_id uuid NOT NULL,
      position    integer NOT NULL,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      item_id     uuid NOT NULL,
      item_name   text NOT NULL,
      qty         integer NOT NULL,
      PRIMARY KEY (transfer_id, position)
    )
  `.execute(db);
  await secureTenantTable(db, 'inventory_transfer_lines');

  await sql`
    CREATE TABLE inventory_transfer_arrivals (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      transfer_id uuid NOT NULL,
      note        text,
      user_id     uuid NOT NULL,
      at          bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_transfer_arrivals_transfer ON inventory_transfer_arrivals (transfer_id, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_transfer_arrivals');

  await sql`
    CREATE TABLE inventory_transfer_arrival_lines (
      arrival_id  uuid NOT NULL,
      position    integer NOT NULL,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      transfer_id uuid NOT NULL,
      item_id     uuid NOT NULL,
      qty         integer NOT NULL,
      PRIMARY KEY (arrival_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_transfer_arrival_lines_transfer ON inventory_transfer_arrival_lines (transfer_id, item_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_transfer_arrival_lines');

  await sql`
    CREATE TABLE inventory_transfer_settlements (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      transfer_id uuid NOT NULL,
      reason      text,
      user_id     uuid NOT NULL,
      at          bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_transfer_settlements_transfer ON inventory_transfer_settlements (transfer_id, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_transfer_settlements');

  await sql`
    CREATE TABLE inventory_transfer_settlement_lines (
      settlement_id uuid NOT NULL,
      position      integer NOT NULL,
      tenant_id     uuid NOT NULL REFERENCES tenants(id),
      transfer_id   uuid NOT NULL,
      item_id       uuid NOT NULL,
      outcome       text NOT NULL,
      qty           integer NOT NULL,
      PRIMARY KEY (settlement_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_inventory_transfer_settlement_lines_transfer ON inventory_transfer_settlement_lines (transfer_id, item_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'inventory_transfer_settlement_lines');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'inventory', ${permission.action}, 'store',
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
  await sql`
    UPDATE permissions SET description =
      'Can add parts that arrived to the store''s stock: on a supplier order, or sent by another store.'
    WHERE id = 'inventory.receive'
  `.execute(db);
  for (const permission of MANAGER_PERMISSIONS) {
    await sql`
      INSERT INTO role_permissions (role_id, permission_id, tenant_id)
      SELECT id, ${permission}, tenant_id FROM roles WHERE name = 'manager' AND is_system_default
      ON CONFLICT DO NOTHING
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions
    WHERE permission_id = 'inventory.receive'
      AND role_id IN (SELECT id FROM roles WHERE name = 'manager' AND is_system_default)
  `.execute(db);
  for (const permission of PERMISSIONS) {
    await sql`DELETE FROM role_permissions WHERE permission_id = ${permission.id}`.execute(db);
    await sql`DELETE FROM permissions WHERE id = ${permission.id}`.execute(db);
  }
  await sql`DROP TABLE inventory_transfer_settlement_lines`.execute(db);
  await sql`DROP TABLE inventory_transfer_settlements`.execute(db);
  await sql`DROP TABLE inventory_transfer_arrival_lines`.execute(db);
  await sql`DROP TABLE inventory_transfer_arrivals`.execute(db);
  await sql`DROP TABLE inventory_transfer_lines`.execute(db);
  await sql`DROP TABLE inventory_transfers`.execute(db);
  await sql`DROP INDEX idx_operations_other_store`.execute(db);
  await sql`ALTER TABLE operations DROP COLUMN other_store_id`.execute(db);
}
