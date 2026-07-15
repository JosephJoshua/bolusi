// SEC-TENANT-02 — RLS enforcement probe (security-guide §8.2).
//
// Every probe here runs through `appForTenant`, i.e. with `SET LOCAL ROLE bolusi_app` inside the
// transaction. testing-guide §2.5: PGlite connects as superuser and superusers bypass RLS, so a
// suite without SET ROLE passes vacuously. The first test below proves this suite is NOT vacuous
// by showing the owner handle CAN read across tenants where the app role cannot.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedNote, seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

/** Two fully-seeded tenants, each with a note. Fresh ids per call (T-3). */
async function seedTwoTenants(): Promise<{
  a: TenantFixture;
  b: TenantFixture;
  bNoteId: string;
}> {
  const a = await seedTenant(testDb.db);
  const b = await seedTenant(testDb.db);
  await seedNote(testDb.db, a);
  const bNoteId = await seedNote(testDb.db, b);
  return { a, b, bNoteId };
}

test('SEC-TENANT-02 the harness is not vacuous: the app role is subject to RLS where the owner is not', async () => {
  // The control test. If SET ROLE ever stops taking effect, every other assertion in this file
  // would pass for the wrong reason — so assert the difference directly.
  const { a } = await seedTwoTenants();

  const asOwner = await testDb.db
    .selectFrom('notes')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  const asApp = await testDb.appForTenant(a.tenantId, async (db) => {
    // Aliased explicitly: CamelCasePlugin rewrites result keys, so `current_user` would arrive
    // as `currentUser`.
    const role = await sql<{ role: string }>`SELECT current_user AS "role"`.execute(db);
    const notes = await db.selectFrom('notes').selectAll().execute();
    return { role: role.rows[0]?.role, notes };
  });

  expect(asApp.role).toBe('bolusi_app');
  expect(Number(asOwner.count)).toBeGreaterThan(1); // owner sees every tenant's notes
  expect(asApp.notes).toHaveLength(1); // app role sees only tenant A's
});

test('SEC-TENANT-02 SELECT as tenant A returns zero of tenant B rows', async () => {
  const { a, b } = await seedTwoTenants();

  const rows = await testDb.appForTenant(a.tenantId, (db) =>
    // No WHERE clause on purpose: RLS is the backstop, not the repository filter
    // (testing-guide §2.5.3).
    db.selectFrom('notes').select(['id', 'tenantId']).execute(),
  );

  expect(rows.every((row) => row.tenantId === a.tenantId)).toBe(true);
  expect(rows.some((row) => row.tenantId === b.tenantId)).toBe(false);
});

test('SEC-TENANT-02 INSERT carrying another tenant id is rejected by WITH CHECK', async () => {
  const { a, b } = await seedTwoTenants();

  await expect(
    testDb.appForTenant(a.tenantId, (db) =>
      db
        .insertInto('notes')
        .values({
          id: uuid(),
          tenantId: b.tenantId, // the forgery
          storeId: b.storeId,
          title: 'planted',
          body: 'planted',
          createdBy: b.userId,
          createdAt: 1n,
          lastEditedBy: b.userId,
          lastEditedAt: 1n,
        })
        .execute(),
    ),
  ).rejects.toThrow(/row-level security/i);
});

test('SEC-TENANT-02 UPDATE targeting another tenant rows affects zero rows', async () => {
  const { a, b, bNoteId } = await seedTwoTenants();

  const affected = await testDb.appForTenant(a.tenantId, async (db) => {
    const result = await db
      .updateTable('notes')
      .set({ title: 'hacked' })
      .where('tenantId', '=', b.tenantId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  });

  expect(affected).toBe(0);

  // And prove it: B's row is untouched when read back with RLS bypassed.
  const bNote = await testDb.db
    .selectFrom('notes')
    .select('title')
    .where('id', '=', bNoteId)
    .executeTakeFirstOrThrow();
  expect(bNote.title).not.toBe('hacked');
});

test('SEC-TENANT-02 DELETE targeting another tenant rows affects zero rows', async () => {
  const { a, b, bNoteId } = await seedTwoTenants();

  const affected = await testDb.appForTenant(a.tenantId, async (db) => {
    const result = await db
      .deleteFrom('notes')
      .where('tenantId', '=', b.tenantId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  });

  expect(affected).toBe(0);

  const survivor = await testDb.db
    .selectFrom('notes')
    .select('id')
    .where('id', '=', bNoteId)
    .executeTakeFirst();
  expect(survivor?.id).toBe(bNoteId);
});

test('SEC-TENANT-02 a transaction with no set_config reads nothing from every tenant table', async () => {
  // security-guide §8.1: "verified by test, not assumed". This is the fail-closed leg, and it is
  // asserted for EVERY tenant table rather than a representative one — a single table left on
  // the two-argument current_setting() form would silently return "no rows" instead of raising.
  //
  // Observed semantics (identical on PGlite 18 and Postgres 16): the one-arg
  // current_setting('app.tenant_id') RAISES on an unset GUC (42704 unrecognized parameter), and
  // raises 22P02 (invalid uuid "") once a previous transaction-local set_config has made the
  // parameter known to the session. Both are fail-closed per 10-db-schema §6.3 ("current_setting
  // with no GUC set → error → fail closed"). What must never happen is rows coming back.
  await seedTwoTenants();

  const { rows: tables } = await sql<{ tableName: string }>`
    SELECT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     ORDER BY c.relname
  `.execute(testDb.db);

  expect(tables.length).toBeGreaterThan(20);

  for (const { tableName } of tables) {
    // A fresh transaction per table: an RLS error aborts its transaction (25P02), so probes
    // must not share one.
    const outcome = await testDb.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      try {
        const result = await sql.raw(`SELECT * FROM ${tableName} LIMIT 1`).execute(trx);
        return { kind: 'rows' as const, count: result.rows.length };
      } catch (error) {
        return { kind: 'error' as const, message: String(error) };
      }
    });

    if (outcome.kind === 'rows') {
      expect(outcome.count, `${tableName} leaked rows with no app.tenant_id set`).toBe(0);
    } else {
      expect(outcome.message, `${tableName} failed for an unexpected reason`).toMatch(
        /app\.tenant_id|invalid input syntax for type uuid/i,
      );
    }
  }
});
