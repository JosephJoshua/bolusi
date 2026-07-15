// SEC-TENANT-01 — RLS coverage sweep (security-guide §8.2, testing-guide §2.5.2).
//
// The sweep enumerates the LIVE CATALOG (pg_class / pg_policy / pg_attribute). It deliberately
// does NOT read a list of tables from src/: a sweep driven by a hand-maintained list can only
// ever find tables somebody remembered to add, which is the exact failure it exists to catch.
// Any future migration that adds a tenant_id column without a policy fails this test.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { createTestDb, type TestDb } from './helpers/test-db.js';

/**
 * Tables allowed to have no RLS. Exhaustive and deliberately tiny (security-guide §8.2:
 * "allowlist for genuinely global tables"):
 *  - `permissions`  — global, code-defined, deploy-seeded reference data with no tenant_id
 *                     (10-db-schema §4). App role gets SELECT only.
 *  - `kysely_*`     — the migrator's own bookkeeping, written by the provisioning role only.
 */
const RLS_EXEMPT = new Set(['permissions', 'kysely_migration', 'kysely_migration_lock']);

/** pg_policy.polcmd → the verbs a policy covers. '*' is Postgres's FOR ALL (all four). */
const POLCMD_VERBS: Record<string, readonly string[]> = {
  '*': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  r: ['SELECT'],
  a: ['INSERT'],
  w: ['UPDATE'],
  d: ['DELETE'],
};

const REQUIRED_VERBS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

interface TableSecurity {
  table: string;
  hasTenantColumn: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  verbs: Set<string>;
}

/**
 * Reads every ordinary table in the app schema straight from the catalog, with its RLS flags
 * and the union of verbs its policies cover.
 */
async function readTableSecurity(testDb: TestDb): Promise<TableSecurity[]> {
  // NOTE: CamelCasePlugin rewrites RESULT keys too, so aliases are quoted camelCase and the
  // row type matches what actually comes back.
  const { rows } = await sql<{
    tableName: string;
    hasTenantColumn: boolean;
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    polcmds: string[] | null;
  }>`
    SELECT c.relname                          AS "tableName",
           EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname IN ('tenant_id')
           )                                  AS "hasTenantColumn",
           c.relrowsecurity                   AS "rowSecurity",
           c.relforcerowsecurity              AS "forceRowSecurity",
           array_agg(p.polcmd::text)          AS "polcmds"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     GROUP BY c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
     ORDER BY c.relname
  `.execute(testDb.db);

  return rows.map((row) => ({
    table: row.tableName,
    hasTenantColumn: row.hasTenantColumn,
    rowSecurity: row.rowSecurity,
    forceRowSecurity: row.forceRowSecurity,
    verbs: new Set((row.polcmds ?? []).filter(Boolean).flatMap((cmd) => POLCMD_VERBS[cmd] ?? [])),
  }));
}

/**
 * The sweep, as a pure predicate over catalog rows, so the fixture test below can run the
 * SAME logic against a deliberately-unprotected table and watch it fail.
 *
 * `tenants` is included by name: it is tenant-scoped via its `id` column rather than a
 * `tenant_id` column (10-db-schema §6.2's `tenant_self` policy), so a column-only rule
 * would miss the single most sensitive table in the schema.
 */
function findUnprotected(tables: TableSecurity[]): string[] {
  const failures: string[] = [];

  for (const t of tables) {
    if (RLS_EXEMPT.has(t.table)) continue;
    const tenantScoped = t.hasTenantColumn || t.table === 'tenants';
    if (!tenantScoped) {
      failures.push(`${t.table}: no tenant_id column and not in the RLS allowlist`);
      continue;
    }
    if (!t.rowSecurity) failures.push(`${t.table}: relrowsecurity = false`);
    if (!t.forceRowSecurity) failures.push(`${t.table}: relforcerowsecurity = false`);

    const missing = REQUIRED_VERBS.filter((verb) => !t.verbs.has(verb));
    if (missing.length > 0) failures.push(`${t.table}: no tenant policy for ${missing.join('/')}`);
  }

  return failures;
}

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

test('SEC-TENANT-01 every tenant table has RLS enabled, forced, and policies covering all four verbs', async () => {
  const tables = await readTableSecurity(testDb);

  // Guard against a sweep that passes because it looked at nothing.
  expect(tables.length).toBeGreaterThan(20);
  expect(tables.map((t) => t.table)).toContain('operations');

  expect(findUnprotected(tables)).toEqual([]);
});

test('SEC-TENANT-01 sweep fails when a tenant table ships without a policy', async () => {
  // The negative control: without this, a sweep with an inverted condition would pass forever.
  const fixture = 'sec_tenant_01_unprotected_fixture';
  await sql
    .raw(`CREATE TABLE ${fixture} (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`)
    .execute(testDb.db);

  try {
    const failures = findUnprotected(await readTableSecurity(testDb));
    expect(failures).toContain(`${fixture}: relrowsecurity = false`);
    expect(failures).toContain(`${fixture}: relforcerowsecurity = false`);
    expect(failures).toContain(`${fixture}: no tenant policy for SELECT/INSERT/UPDATE/DELETE`);
  } finally {
    await sql.raw(`DROP TABLE ${fixture}`).execute(testDb.db);
  }
});

test('SEC-TENANT-01 sweep fails when a tenant table enables RLS but does not FORCE it', async () => {
  // ENABLE without FORCE leaves the table owner exempt — the silent half of the failure mode
  // (security-guide §8.1). A sweep that only checked relrowsecurity would miss this entirely.
  const fixture = 'sec_tenant_01_unforced_fixture';
  await sql
    .raw(`CREATE TABLE ${fixture} (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`)
    .execute(testDb.db);
  await sql.raw(`ALTER TABLE ${fixture} ENABLE ROW LEVEL SECURITY`).execute(testDb.db);
  await sql
    .raw(
      `CREATE POLICY tenant_isolation ON ${fixture} FOR ALL ` +
        `USING (tenant_id = current_setting('app.tenant_id')::uuid) ` +
        `WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`,
    )
    .execute(testDb.db);

  try {
    const failures = findUnprotected(await readTableSecurity(testDb));
    expect(failures).toEqual([`${fixture}: relforcerowsecurity = false`]);
  } finally {
    await sql.raw(`DROP TABLE ${fixture}`).execute(testDb.db);
  }
});

test('SEC-TENANT-01 sweep fails when a policy covers only some verbs', async () => {
  // FOR SELECT alone is the "read is protected, writes are not" trap.
  const fixture = 'sec_tenant_01_partial_verbs_fixture';
  await sql
    .raw(`CREATE TABLE ${fixture} (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`)
    .execute(testDb.db);
  await sql.raw(`ALTER TABLE ${fixture} ENABLE ROW LEVEL SECURITY`).execute(testDb.db);
  await sql.raw(`ALTER TABLE ${fixture} FORCE ROW LEVEL SECURITY`).execute(testDb.db);
  await sql
    .raw(
      `CREATE POLICY tenant_read_only ON ${fixture} FOR SELECT ` +
        `USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
    )
    .execute(testDb.db);

  try {
    const failures = findUnprotected(await readTableSecurity(testDb));
    expect(failures).toEqual([`${fixture}: no tenant policy for INSERT/UPDATE/DELETE`]);
  } finally {
    await sql.raw(`DROP TABLE ${fixture}`).execute(testDb.db);
  }
});

test('the RLS allowlist contains only genuinely global tables', async () => {
  // Pins the allowlist itself: a future task must not quietly widen it to hide a failure.
  const tables = await readTableSecurity(testDb);
  const exemptWithTenantColumn = tables
    .filter((t) => RLS_EXEMPT.has(t.table) && t.hasTenantColumn)
    .map((t) => t.table);

  expect(exemptWithTenantColumn).toEqual([]);
  expect([...RLS_EXEMPT].sort()).toEqual([
    'kysely_migration',
    'kysely_migration_lock',
    'permissions',
  ]);
});
