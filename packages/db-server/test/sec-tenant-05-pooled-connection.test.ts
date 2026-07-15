// SEC-TENANT-05 — pooled-connection leak (security-guide §8.2).
//
// The threat: `set_config(..., is_local => false)`, or a session-level `SET` of the
// `app.tenant_id` GUC, binds it for the whole CONNECTION. Pools hand that connection to the next
// request, which then runs as the previous tenant. Transaction-local is the mitigation
// (10-db §6.1); this file proves it holds across sequential transactions on the same pooled
// connection.
//
// (The phrasing above deliberately avoids writing the forbidden statement literally:
// `check-tenant-context.mjs` greps the repo for it and cannot tell prose from SQL. This file is
// NOT on its exemption list, and should stay off it.)
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedNote, seedTenant } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;

beforeAll(async () => {
  // maxUses/pool size are irrelevant on PGlite (a single connection by construction), which is
  // itself the harshest possible version of this test: EVERY transaction reuses one connection.
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

test('SEC-TENANT-05 sequential transactions on the same pool see only their own tenant', async () => {
  const a = await seedTenant(testDb.db);
  const b = await seedTenant(testDb.db);
  const aNoteId = await seedNote(testDb.db, a);
  const bNoteId = await seedNote(testDb.db, b);

  const first = await testDb.appForTenant(a.tenantId, async (db) => ({
    guc: (await sql<{ g: string }>`SELECT current_setting('app.tenant_id') AS g`.execute(db))
      .rows[0]?.g,
    noteIds: (await db.selectFrom('notes').select('id').execute()).map((r) => r.id),
  }));

  // Same pool, immediately afterwards, different tenant.
  const second = await testDb.appForTenant(b.tenantId, async (db) => ({
    guc: (await sql<{ g: string }>`SELECT current_setting('app.tenant_id') AS g`.execute(db))
      .rows[0]?.g,
    noteIds: (await db.selectFrom('notes').select('id').execute()).map((r) => r.id),
  }));

  expect(first.guc).toBe(a.tenantId);
  expect(first.noteIds).toEqual([aNoteId]);

  // B's transaction must return B — not A's leftover value — and see zero A rows.
  expect(second.guc).toBe(b.tenantId);
  expect(second.noteIds).toEqual([bNoteId]);
  expect(second.noteIds).not.toContain(aNoteId);
});

test('SEC-TENANT-05 the tenant GUC does not survive its transaction', async () => {
  const a = await seedTenant(testDb.db);
  await testDb.appForTenant(a.tenantId, async () => undefined);

  // is_local = true means the value is rolled back at COMMIT. If this ever returns the tenant
  // id, some code path has switched to a session-level SET and every pooled request is exposed.
  const after = await testDb.db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ g: string | null }>`
      SELECT current_setting('app.tenant_id', true) AS g
    `.execute(trx);
    return rows[0]?.g;
  });

  expect(after == null || after === '').toBe(true);
});

test('SEC-TENANT-05 a set_config-skipping bypass reads nothing, not everything', async () => {
  // The "harness bypass" leg: a caller that reaches the DB WITHOUT forTenant must not thereby
  // gain unfiltered access. Fail-closed here is an error, not an empty set (10-db §6.3) — what
  // matters is that no row is returned.
  const a = await seedTenant(testDb.db);
  await seedNote(testDb.db, a);

  const outcome = await testDb.db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
    try {
      const rows = await sql<{ id: string }>`SELECT id FROM notes`.execute(trx);
      return { kind: 'rows' as const, rows: rows.rows };
    } catch (error) {
      return { kind: 'error' as const, message: String(error) };
    }
  });

  if (outcome.kind === 'rows') {
    expect(outcome.rows).toEqual([]);
  } else {
    expect(outcome.message).toMatch(/app\.tenant_id|invalid input syntax for type uuid/i);
  }
});

test('SEC-TENANT-05 a tenant id that is not lowercase canonical UUID text never reaches the database', async () => {
  const a = await seedTenant(testDb.db);

  // Uppercase is the interesting case: Postgres would happily normalise it, so only the
  // application boundary can keep 10-db §2's lowercase rule true (and with it the cross-engine
  // canonical ordering of 05-operation-log §4).
  await expect(
    testDb.appForTenant(a.tenantId.toUpperCase(), async () => 'reached'),
  ).rejects.toThrow(/lowercase canonical UUID/);
});

test(`SEC-TENANT-05 runs against the ${ENGINE} engine`, () => {
  // Makes the engine visible in the report: a green run means nothing if it silently ran the
  // fast lane when the merge gate asked for the real one (08 §5.6 stage 9).
  expect(['pglite', 'postgres']).toContain(ENGINE);
});
