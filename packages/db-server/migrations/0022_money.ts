// The `money` ledger: payment accounts, money records and their double-entry lines
// (product-scope.md, "Repair payments"). Mirrors client migration 18.
//
// Permissions are seeded here because the app role cannot write the global `permissions` table.
// The counter takes payments, gives back overpayments, moves and counts cash; only owners refund
// more, lower a bill, cancel a payment, settle a cash difference or set up accounts. A line id is
// `<entry id>:<n>`, so it is text. Merge after 0021: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'money.read',
    action: 'read',
    scope: 'store',
    isDangerous: false,
    description: "Can see the store's money: payments, refunds, the cash drawer and unpaid bills.",
  },
  {
    id: 'money.receive',
    action: 'receive',
    scope: 'store',
    isDangerous: false,
    description:
      'Can take payments from customers and give back what a customer paid beyond their bill.',
  },
  {
    id: 'money.refund',
    action: 'refund',
    scope: 'store',
    isDangerous: true,
    description: 'Can give customers money back and lower what a customer owes.',
  },
  {
    id: 'money.void_payment',
    action: 'void_payment',
    scope: 'store',
    isDangerous: true,
    description: 'Can cancel a payment that was recorded by mistake.',
  },
  {
    id: 'money.move_cash',
    action: 'move_cash',
    scope: 'store',
    isDangerous: true,
    description:
      'Can take cash out of the drawer (for the owner, an expense, a bank deposit) or put cash in.',
  },
  {
    id: 'money.count_cash',
    action: 'count_cash',
    scope: 'store',
    isDangerous: false,
    description: 'Can count the cash drawer at closing.',
  },
  {
    id: 'money.adjust_cash',
    action: 'adjust_cash',
    scope: 'store',
    isDangerous: true,
    description: "Can settle a difference between the counted cash and the store's records.",
  },
  {
    id: 'money.manage_accounts',
    action: 'manage_accounts',
    scope: 'store',
    isDangerous: true,
    description: "Can add and change the store's QRIS, card machine and bank accounts.",
  },
  {
    id: 'money.manage_central_accounts',
    action: 'manage_central_accounts',
    scope: 'tenant',
    isDangerous: true,
    description: 'Can add and change the QRIS, card machine and bank accounts shared by stores.',
  },
] as const;

/** Which system-default roles get each permission. main_owner holds them all. */
const STORE_OWNER = PERMISSIONS.filter((p) => p.scope === 'store').map((p) => p.id);
const CASHIER = ['money.read', 'money.receive', 'money.move_cash', 'money.count_cash'];
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  main_owner: PERMISSIONS.map((p) => p.id),
  store_owner: STORE_OWNER,
  cashier: CASHIER,
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE money_accounts (
      id             uuid PRIMARY KEY,
      tenant_id      uuid NOT NULL REFERENCES tenants(id),
      store_id       uuid REFERENCES stores(id),
      kind           text NOT NULL,
      name           text NOT NULL,
      active         integer NOT NULL,
      store_ids_json text,
      created_at     bigint NOT NULL,
      updated_by     uuid NOT NULL,
      updated_at     bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'money_accounts');

  await sql`
    CREATE TABLE money_entries (
      id               uuid PRIMARY KEY,
      tenant_id        uuid NOT NULL REFERENCES tenants(id),
      store_id         uuid NOT NULL REFERENCES stores(id),
      kind             text NOT NULL,
      document_kind    text,
      document_id      uuid,
      document_label   text,
      account          text,
      amount           bigint NOT NULL,
      sub_kind         text,
      reference        text,
      reason           text,
      tendered         bigint,
      related_entry_id uuid,
      created_by       uuid NOT NULL,
      created_at       bigint NOT NULL,
      voided_by        uuid,
      voided_at        bigint,
      void_reason      text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_money_entries_store_created ON money_entries (store_id, created_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_money_entries_store_kind ON money_entries (store_id, kind, created_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_money_entries_related ON money_entries (related_entry_id)`.execute(db);
  await sql`CREATE INDEX idx_money_entries_document ON money_entries (document_id)`.execute(db);
  await secureTenantTable(db, 'money_entries');

  await sql`
    CREATE TABLE money_lines (
      id            text PRIMARY KEY,
      tenant_id     uuid NOT NULL REFERENCES tenants(id),
      store_id      uuid NOT NULL REFERENCES stores(id),
      entry_id      uuid NOT NULL,
      account       text NOT NULL,
      document_kind text,
      document_id   uuid,
      debit         bigint NOT NULL,
      credit        bigint NOT NULL,
      at            bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_money_lines_entry ON money_lines (entry_id)`.execute(db);
  await sql`CREATE INDEX idx_money_lines_document ON money_lines (document_id, account)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_money_lines_store_account ON money_lines (store_id, account, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'money_lines');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'money', ${permission.action}, ${permission.scope},
        ${permission.description}, ${permission.isDangerous})
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
  }
  for (const [role, permissionIds] of Object.entries(GRANTS)) {
    for (const permissionId of permissionIds) {
      await sql`
        INSERT INTO role_permissions (role_id, permission_id, tenant_id)
        SELECT id, ${permissionId}, tenant_id FROM roles WHERE name = ${role} AND is_system_default
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
  await sql`DROP TABLE money_lines`.execute(db);
  await sql`DROP TABLE money_entries`.execute(db);
  await sql`DROP TABLE money_accounts`.execute(db);
}
