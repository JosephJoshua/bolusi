// Staff pay (product-scope.md, "Staff pay"): salaries, commission rates, kasbon, monthly payouts
// and commission changed by hand. Mirrors client migration 35.
//
// Every role holds `pay.own` (each person's own statement). The owners' system-default roles get
// every pay permission, as provisioning grants them to new businesses; the manager's gets kasbon.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'pay.own',
    action: 'own',
    description: 'Can see their own pay: salary, commission, kasbon and payouts.',
    dangerous: false,
  },
  {
    id: 'pay.read',
    action: 'read',
    description: "Can see everyone's salary, commission and payouts at the store.",
    dangerous: false,
  },
  {
    id: 'pay.advances',
    action: 'advances',
    description: 'Can give staff a kasbon (an advance) and take repayments.',
    dangerous: true,
  },
  {
    id: 'pay.pay',
    action: 'pay',
    description: "Can pay staff their month's salary and commission.",
    dangerous: true,
  },
  {
    id: 'pay.manage',
    action: 'manage',
    description:
      'Can set staff salaries and commission rates, change commission by hand, cancel pay records and write off kasbon.',
    dangerous: true,
  },
] as const;

const OWNER_ROLES = ['main_owner', 'store_owner'] as const;

const VOID = sql`voided_by uuid, voided_at bigint, void_reason text`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pay_terms (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      store_id           uuid NOT NULL REFERENCES stores(id),
      user_id            uuid NOT NULL,
      salary             bigint NOT NULL,
      commission_percent integer,
      set_by             uuid NOT NULL,
      set_at             bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_terms_user ON pay_terms (store_id, user_id, set_at)`.execute(db);
  await secureTenantTable(db, 'pay_terms');

  await sql`
    CREATE TABLE pay_store_rates (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      store_id           uuid NOT NULL REFERENCES stores(id),
      commission_percent integer,
      set_by             uuid NOT NULL,
      set_at             bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_store_rates_store ON pay_store_rates (store_id, set_at)`.execute(
    db,
  );
  await secureTenantTable(db, 'pay_store_rates');

  await sql`
    CREATE TABLE pay_advances (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      user_id     uuid NOT NULL,
      amount      bigint NOT NULL,
      account     text NOT NULL,
      reason      text NOT NULL,
      installment bigint NOT NULL,
      created_by  uuid NOT NULL,
      created_at  bigint NOT NULL,
      ${VOID}
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_advances_user ON pay_advances (store_id, user_id)`.execute(db);
  await secureTenantTable(db, 'pay_advances');

  await sql`
    CREATE TABLE pay_repayments (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      store_id   uuid NOT NULL REFERENCES stores(id),
      user_id    uuid NOT NULL,
      amount     bigint NOT NULL,
      via        text NOT NULL,
      payout_id  uuid,
      note       text,
      created_by uuid NOT NULL,
      created_at bigint NOT NULL,
      ${VOID}
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_repayments_user ON pay_repayments (store_id, user_id)`.execute(db);
  await secureTenantTable(db, 'pay_repayments');

  await sql`
    CREATE TABLE pay_payouts (
      id           uuid PRIMARY KEY,
      tenant_id    uuid NOT NULL REFERENCES tenants(id),
      store_id     uuid NOT NULL REFERENCES stores(id),
      user_id      uuid NOT NULL,
      month        text NOT NULL,
      salary       bigint NOT NULL,
      commission   bigint NOT NULL,
      deduction    bigint NOT NULL,
      repayment_id uuid,
      paid         bigint NOT NULL,
      account      text NOT NULL,
      note         text,
      created_by   uuid NOT NULL,
      created_at   bigint NOT NULL,
      ${VOID}
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_payouts_user ON pay_payouts (store_id, user_id, month)`.execute(
    db,
  );
  await secureTenantTable(db, 'pay_payouts');

  await sql`
    CREATE TABLE pay_adjustments (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      store_id   uuid NOT NULL REFERENCES stores(id),
      user_id    uuid NOT NULL,
      amount     bigint NOT NULL,
      reason     text NOT NULL,
      created_by uuid NOT NULL,
      created_at bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_pay_adjustments_user ON pay_adjustments (store_id, user_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'pay_adjustments');

  for (const permission of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${permission.id}, 'pay', ${permission.action}, 'store',
        ${permission.description}, ${permission.dangerous})
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
  // Held by every role, as the role editor keeps it (role-abilities ROLE_BASE_PERMISSIONS).
  await sql`
    INSERT INTO role_permissions (role_id, permission_id, tenant_id)
    SELECT id, 'pay.own', tenant_id FROM roles
    ON CONFLICT DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO role_permissions (role_id, permission_id, tenant_id)
    SELECT id, 'pay.advances', tenant_id FROM roles WHERE name = 'manager' AND is_system_default
    ON CONFLICT DO NOTHING
  `.execute(db);

  // A kasbon above a limited role's store limit needs an owner, so a store sets that amount too.
  await sql`ALTER TABLE role_limits DROP CONSTRAINT role_limits_kind_check`.execute(db);
  await sql`
    ALTER TABLE role_limits ADD CONSTRAINT role_limits_kind_check
      CHECK (kind IN ('priceDrop', 'refund', 'credit', 'advance'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM role_limits WHERE kind = 'advance'`.execute(db);
  await sql`ALTER TABLE role_limits DROP CONSTRAINT role_limits_kind_check`.execute(db);
  await sql`
    ALTER TABLE role_limits ADD CONSTRAINT role_limits_kind_check
      CHECK (kind IN ('priceDrop', 'refund', 'credit'))
  `.execute(db);
  for (const permission of PERMISSIONS) {
    await sql`DELETE FROM role_permissions WHERE permission_id = ${permission.id}`.execute(db);
    await sql`DELETE FROM permissions WHERE id = ${permission.id}`.execute(db);
  }
  for (const table of [
    'pay_adjustments',
    'pay_payouts',
    'pay_repayments',
    'pay_advances',
    'pay_store_rates',
    'pay_terms',
  ]) {
    await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  }
}
