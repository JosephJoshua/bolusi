// Tenancy enforcement primitives shared by the migrations (10-db-schema §6).
//
// security-guide §8.1 is normative: every tenant table's migration enables AND forces
// RLS and creates its policies IN THE SAME MIGRATION as the table. These helpers are the
// "loop this in the migration" of 10-db §6.2 — one call per table, so a new table cannot
// quietly ship without its policy. SEC-TENANT-01 is the backstop that makes forgetting fail CI.
import { sql, type Kysely } from 'kysely';

/** §6.3: request handlers. NOT the table owner, NOSUPERUSER, no BYPASSRLS. */
export const APP_ROLE = 'bolusi_app';

/** §6.3: provisioning CLI + migrations only. Table owner. Never reachable from Hono code paths. */
export const PROVISION_ROLE = 'bolusi_provision';

/**
 * What `bolusi_app` may do to a table (§6.3 grant matrix).
 * - `crud`        — SELECT/INSERT/UPDATE/DELETE (the default for tenant tables)
 * - `read-append` — SELECT, INSERT only. `operations` (§5: append-only, the grant is the
 *                   "belt" behind the forbid_mutation trigger) and `identity_audit` (§7).
 * - `read-only`   — SELECT only. `permissions`: global, deploy-seeded reference data (§4).
 */
export type AppGrant = 'crud' | 'read-append' | 'read-only';

const GRANT_VERBS: Record<AppGrant, string> = {
  crud: 'SELECT, INSERT, UPDATE, DELETE',
  'read-append': 'SELECT, INSERT',
  'read-only': 'SELECT',
};

/**
 * Hands the table to `bolusi_provision` (§6.3 "Table owner").
 *
 * Migrations run as the bootstrap superuser; ownership moves to the provisioning role so the
 * app role is never the owner. Combined with FORCE ROW LEVEL SECURITY this means even the
 * owner is subject to the tenant predicate — see `enableTenantRls`.
 */
export async function ownTable(db: Kysely<unknown>, table: string): Promise<void> {
  await sql`ALTER TABLE ${sql.table(table)} OWNER TO ${sql.id(PROVISION_ROLE)}`.execute(db);
}

/** §6.3 grant matrix for the app role. */
export async function grantToApp(
  db: Kysely<unknown>,
  table: string,
  grant: AppGrant,
): Promise<void> {
  await sql`GRANT ${sql.raw(GRANT_VERBS[grant])} ON ${sql.table(table)} TO ${sql.id(APP_ROLE)}`.execute(
    db,
  );
}

/**
 * The §6.2 policy template, verbatim.
 *
 * FORCE is load-bearing (security-guide §8.1): without it the table owner bypasses the policy,
 * so a misconfiguration that runs handlers as the owner would silently serve every tenant.
 *
 * The policy is `FOR ALL`, which is Postgres's all-four-verbs form (`pg_policy.polcmd = '*'`):
 * USING gates SELECT/UPDATE/DELETE row visibility, WITH CHECK gates INSERT/UPDATE row contents.
 *
 * `current_setting('app.tenant_id')` is the ONE-ARGUMENT form on purpose (§6.3: "current_setting
 * with no GUC set → error → fail closed"). The two-arg form would return NULL and degrade the
 * predicate to "no rows" silently; the raising form makes a missing set_config loud.
 * SEC-TENANT-02/05 pin this behaviour instead of assuming it.
 */
export async function enableTenantRls(
  db: Kysely<unknown>,
  table: string,
  options: { column?: string; policy?: string } = {},
): Promise<void> {
  const column = options.column ?? 'tenant_id';
  const policy = options.policy ?? 'tenant_isolation';

  await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY ${sql.id(policy)} ON ${sql.table(table)}
      FOR ALL
      USING      (${sql.ref(column)} = current_setting('app.tenant_id')::uuid)
      WITH CHECK (${sql.ref(column)} = current_setting('app.tenant_id')::uuid)
  `.execute(db);
}

/**
 * One call per tenant-scoped table: own → enable+force RLS + policy → grant.
 * This is the whole of §6.2/§6.3 for a table, so it cannot be half-applied.
 */
export async function secureTenantTable(
  db: Kysely<unknown>,
  table: string,
  options: { column?: string; policy?: string; grant?: AppGrant } = {},
): Promise<void> {
  await ownTable(db, table);
  await enableTenantRls(db, table, options);
  await grantToApp(db, table, options.grant ?? 'crud');
}
