// SEC-TENANT-01 — RLS coverage sweep (security-guide §8.2, testing-guide §2.5.2).
//
// The sweep enumerates the LIVE CATALOG (pg_class / pg_policy / pg_attribute). It deliberately
// does NOT read a list of tables from src/: a sweep driven by a hand-maintained list can only
// ever find relations somebody remembered to add, which is the exact failure it exists to catch.
//
// COVERAGE, stated precisely — the previous wording here ("any future migration that adds a
// tenant_id column without a policy fails this test") was an OVERCLAIM, and a guard that
// overstates its reach is worse than one that admits a gap: the next agent trusts it.
// The sweep covers ordinary tables (relkind 'r'), views ('v') and materialized views ('m').
//
// Views are included because RLS does NOT protect them by default. A Postgres view executes with
// its OWNER's rights unless `security_invoker=true`; migrations run as the bootstrap superuser,
// and a superuser bypasses RLS **even under FORCE**. So a convenience view created by a
// migration that forgets `ALTER VIEW … OWNER TO bolusi_provision` serves EVERY tenant's rows
// while every base table stays correctly isolated and CI stays green. Ownership is the lever:
// the same view re-owned to bolusi_provision does not leak, because FORCE subjects even the
// owner to the policy. There are no views in v0 — this guard exists so the first one cannot be
// the one that finds out, and cross-store owner dashboards (OQ-1103) make a reporting view the
// most likely next thing someone writes.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedNote, seedTenant } from './helpers/fixtures.js';
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
  /** 'r' ordinary table · 'v' view · 'm' materialized view. */
  kind: string;
  hasTenantColumn: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  verbs: Set<string>;
  owner: string;
  ownerIsSuperuser: boolean;
  securityInvoker: boolean;
}

/**
 * Reads every table, view and matview in the app schema straight from the catalog, with its RLS
 * flags, the union of verbs its policies cover, and the ownership/security_invoker facts that
 * decide whether a view can bypass RLS.
 */
async function readTableSecurity(testDb: TestDb): Promise<TableSecurity[]> {
  // NOTE: CamelCasePlugin rewrites RESULT keys too, so aliases are quoted camelCase and the
  // row type matches what actually comes back.
  const { rows } = await sql<{
    tableName: string;
    kind: string;
    hasTenantColumn: boolean;
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    polcmds: string[] | null;
    owner: string;
    ownerIsSuperuser: boolean;
    securityInvoker: boolean;
  }>`
    SELECT c.relname                          AS "tableName",
           c.relkind::text                    AS "kind",
           EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname IN ('tenant_id')
           )                                  AS "hasTenantColumn",
           c.relrowsecurity                   AS "rowSecurity",
           c.relforcerowsecurity              AS "forceRowSecurity",
           array_agg(p.polcmd::text)          AS "polcmds",
           r.rolname                          AS "owner",
           r.rolsuper                         AS "ownerIsSuperuser",
           COALESCE(
             (SELECT o.option_value = 'true'
                FROM pg_options_to_table(c.reloptions) o
               WHERE o.option_name = 'security_invoker'),
             false
           )                                  AS "securityInvoker"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm')
     GROUP BY c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
              c.reloptions, r.rolname, r.rolsuper
     ORDER BY c.relname
  `.execute(testDb.db);

  return rows.map((row) => ({
    table: row.tableName,
    kind: row.kind,
    hasTenantColumn: row.hasTenantColumn,
    rowSecurity: row.rowSecurity,
    forceRowSecurity: row.forceRowSecurity,
    verbs: new Set((row.polcmds ?? []).filter(Boolean).flatMap((cmd) => POLCMD_VERBS[cmd] ?? [])),
    owner: row.owner,
    ownerIsSuperuser: row.ownerIsSuperuser,
    securityInvoker: row.securityInvoker,
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
    // Views and matviews: RLS flags/policies do not apply to the view itself — what decides
    // whether the BASE tables' policies run is whose rights the view executes with. A view owned
    // by a superuser bypasses RLS even under FORCE (superusers are exempt, full stop), so it
    // serves every tenant. Two acceptable shapes: `security_invoker=true` (runs as the caller,
    // i.e. bolusi_app, so policies apply), or a non-superuser owner (bolusi_provision — FORCE
    // then subjects the owner too, which the reviewer confirmed does NOT leak).
    //
    // Matviews cannot be security_invoker and their data is materialized at refresh time, so
    // only the ownership leg can save them; in practice a tenant-scoped matview is a design
    // question, not a config one — this fires and someone decides.
    if (t.kind === 'v' || t.kind === 'm') {
      if (t.ownerIsSuperuser && !t.securityInvoker) {
        failures.push(
          `${t.table}: ${t.kind === 'm' ? 'matview' : 'view'} owned by superuser '${t.owner}' ` +
            `without security_invoker — it bypasses RLS and serves every tenant ` +
            `(ALTER ${t.kind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${t.table} OWNER TO bolusi_provision)`,
        );
      }
      continue;
    }

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

test('SEC-TENANT-01 every tenant table has RLS enabled, forced, and policies covering all four verbs (I-5: every tenant row carries tenantId, enforced by the two-layer scheme)', async () => {
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

test('SEC-TENANT-01 sweep fails when a view is owned by a superuser without security_invoker', async () => {
  // The gap this test exists for: a view bypasses RLS entirely and the sweep used to be blind to
  // it (`relkind = 'r'` only). Migrations run as the bootstrap superuser, so the natural
  // `CREATE VIEW` — e.g. the cross-store owner dashboard of OQ-1103 — inherits superuser
  // ownership and serves every tenant while every base table stays correctly isolated.
  const fixture = 'sec_tenant_01_leaky_view_fixture';
  await sql
    .raw(`CREATE VIEW ${fixture} AS SELECT id, tenant_id, title FROM notes`)
    .execute(testDb.db);

  try {
    const swept = await readTableSecurity(testDb);
    const view = swept.find((t) => t.table === fixture);

    // Assert the fixture is real before trusting any verdict about it.
    expect(view, 'the fixture view was not swept at all').toBeDefined();
    expect(view?.kind).toBe('v');
    expect(view?.ownerIsSuperuser, 'fixture precondition: created by the superuser').toBe(true);
    expect(view?.securityInvoker).toBe(false);

    expect(findUnprotected(swept)).toContainEqual(expect.stringContaining(`${fixture}: view`));
  } finally {
    await sql.raw(`DROP VIEW ${fixture}`).execute(testDb.db);
  }
});

test('SEC-TENANT-01 sweep accepts a view re-owned to the provisioning role', async () => {
  // The other half, and the reason ownership is the lever rather than a proxy for it: FORCE ROW
  // LEVEL SECURITY subjects even the owner to the policy, so a view owned by bolusi_provision
  // does NOT leak. Without this, the rule above could be satisfied by banning views outright,
  // which would be a guard that fires on the safe shape too.
  const fixture = 'sec_tenant_01_owned_view_fixture';
  await sql
    .raw(`CREATE VIEW ${fixture} AS SELECT id, tenant_id, title FROM notes`)
    .execute(testDb.db);
  await sql.raw(`ALTER VIEW ${fixture} OWNER TO bolusi_provision`).execute(testDb.db);

  try {
    const swept = await readTableSecurity(testDb);
    const view = swept.find((t) => t.table === fixture);
    expect(view?.ownerIsSuperuser, 'fixture precondition: re-owned to a non-superuser').toBe(false);

    expect(findUnprotected(swept).filter((f) => f.startsWith(fixture))).toEqual([]);
  } finally {
    await sql.raw(`DROP VIEW ${fixture}`).execute(testDb.db);
  }
});

test('SEC-TENANT-01 a superuser-owned view really does leak every tenant, and re-owning it fixes that', async () => {
  // The BEHAVIOUR the catalog rule above is a proxy for. Asserting `ownerIsSuperuser` is only
  // meaningful if superuser ownership actually leaks — so drive it, rather than trust the
  // property. If Postgres ever changed view semantics, the catalog check would keep passing and
  // this would not.
  const a = await seedTenant(testDb.db);
  const b = await seedTenant(testDb.db);
  const aNoteId = await seedNote(testDb.db, a);
  const bNoteId = await seedNote(testDb.db, b);

  const fixture = 'sec_tenant_01_leak_behaviour_fixture';
  await sql
    .raw(`CREATE VIEW ${fixture} AS SELECT id, tenant_id, title FROM notes`)
    .execute(testDb.db);
  // The GRANT is part of the realistic shape, not scaffolding: a migration adding a view FOR the
  // app grants it SELECT, or the view is useless. Without the grant the app simply gets
  // "permission denied" and the leak is unreachable — which would have made this test pass for
  // the wrong reason. (It did, first run: driving the behaviour found the gap in the fixture.)
  await sql.raw(`GRANT SELECT ON ${fixture} TO bolusi_app`).execute(testDb.db);

  try {
    // FIXTURE PRESENCE FIRST: an empty base table would make every read below look like perfect
    // isolation. A vacuous pass here would be indistinguishable from a correct one.
    const seeded = await testDb.db
      .selectFrom('notes')
      .select('id')
      .where('id', 'in', [aNoteId, bNoteId])
      .execute();
    expect(
      seeded.map((r) => r.id).sort(),
      'fixture rows missing — result would be vacuous',
    ).toEqual([aNoteId, bNoteId].sort());

    // As bolusi_app scoped to tenant A, through the superuser-owned view.
    const throughLeakyView = await testDb.appForTenant(a.tenantId, async (db) => {
      const r = await sql<{ id: string }>`SELECT id FROM ${sql.table(fixture)}`.execute(db);
      return r.rows.map((x) => x.id);
    });

    // The leak, demonstrated: tenant A sees tenant B's row.
    expect(throughLeakyView).toContain(bNoteId);

    // ...while the base table, same role, same transaction shape, is correctly isolated.
    const throughBaseTable = await testDb.appForTenant(a.tenantId, (db) =>
      db.selectFrom('notes').select('id').execute(),
    );
    expect(throughBaseTable.map((r) => r.id)).not.toContain(bNoteId);
    expect(throughBaseTable.map((r) => r.id)).toContain(aNoteId);

    // Ownership is the lever: re-own to the provisioning role and the SAME view stops leaking,
    // because FORCE ROW LEVEL SECURITY subjects even the owner to the policy.
    await sql.raw(`ALTER VIEW ${fixture} OWNER TO bolusi_provision`).execute(testDb.db);
    const throughOwnedView = await testDb.appForTenant(a.tenantId, async (db) => {
      const r = await sql<{ id: string }>`SELECT id FROM ${sql.table(fixture)}`.execute(db);
      return r.rows.map((x) => x.id);
    });

    expect(throughOwnedView).toContain(aNoteId);
    expect(throughOwnedView).not.toContain(bNoteId);
  } finally {
    await sql.raw(`DROP VIEW ${fixture}`).execute(testDb.db);
  }
});

test('SEC-TENANT-01 the sweep enumerates views, not only ordinary tables', async () => {
  // Pins the widened relkind filter itself. If someone narrows it back to 'r', the two tests
  // above would pass vacuously (their fixture would simply never be swept) — this one would not.
  const fixture = 'sec_tenant_01_relkind_probe';
  await sql.raw(`CREATE VIEW ${fixture} AS SELECT 1 AS one`).execute(testDb.db);

  try {
    const swept = await readTableSecurity(testDb);
    expect(swept.map((t) => t.table)).toContain(fixture);
    expect(swept.some((t) => t.kind === 'v')).toBe(true);
  } finally {
    await sql.raw(`DROP VIEW ${fixture}`).execute(testDb.db);
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
