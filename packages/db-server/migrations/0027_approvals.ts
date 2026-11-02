// Approval requests (product-scope.md, "Managers, limits, approvals and roles"): someone asks an
// owner, or someone whose limit covers it, to make a decision they may not make themselves.
// Mirrors client migration 23.
//
// Asking and answering is a store permission every role holds; what someone may ask for and decide
// is the decision's own permission. Merge after 0026: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const APPROVALS_USE = {
  id: 'approvals.use',
  action: 'use',
  description:
    'Can ask for an approval and answer the requests they may decide. What may be asked and decided is the permission of the decision itself.',
} as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE approval_requests (
      id           uuid PRIMARY KEY,
      tenant_id    uuid NOT NULL REFERENCES tenants(id),
      store_id     uuid NOT NULL REFERENCES stores(id),
      kind         text NOT NULL,
      target_type  text NOT NULL,
      target_id    uuid NOT NULL,
      input_json   text NOT NULL,
      amount       bigint NOT NULL,
      reason       text NOT NULL,
      basis        text NOT NULL,
      requested_by uuid NOT NULL,
      requested_at bigint NOT NULL,
      status       text NOT NULL,
      decided_by   uuid,
      decided_at   bigint,
      note         text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_approval_requests_target ON approval_requests (target_id, requested_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_approval_requests_store_status ON approval_requests (store_id, status, requested_at)`.execute(
    db,
  );
  await secureTenantTable(db, 'approval_requests');

  await sql`
    INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
    VALUES (${APPROVALS_USE.id}, 'approvals', ${APPROVALS_USE.action}, 'store',
      ${APPROVALS_USE.description}, false)
    ON CONFLICT (id) DO UPDATE SET
      module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
      description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
  `.execute(db);
  // Every role, made ones included: like a person's own PIN, it is held by all.
  await sql`
    INSERT INTO role_permissions (role_id, permission_id, tenant_id)
    SELECT id, ${APPROVALS_USE.id}, tenant_id FROM roles
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM role_permissions WHERE permission_id = ${APPROVALS_USE.id}`.execute(db);
  await sql`DELETE FROM permissions WHERE id = ${APPROVALS_USE.id}`.execute(db);
  await sql`DROP TABLE approval_requests`.execute(db);
}
