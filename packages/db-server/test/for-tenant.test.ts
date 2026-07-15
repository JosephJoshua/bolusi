// forTenant unit behaviour (task 05 acceptance (a)–(c); 10-db-schema §6.1).
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedNote, seedTenant } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let statements: string[] = [];
let testDb: TestDb;

/**
 * The logged statements with transaction control removed.
 *
 * Engine drift, caught by the real-Postgres lane: PostgresDialect issues `begin`/`commit` as
 * logged queries, while the PGlite dialect drives transactions through its own API and logs
 * neither. Filtering them keeps the assertion on the thing that actually matters — set_config
 * precedes every real statement — instead of on which dialect narrates its BEGIN.
 */
function queries(): string[] {
  return statements.filter((text) => !/^\s*(begin|commit|rollback)\b/i.test(text));
}

beforeAll(async () => {
  testDb = await createTestDb({
    onQuery: (text) => {
      statements.push(text);
    },
  });
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

test('forTenant issues set_config as the first statement in the transaction', async () => {
  const tenant = await seedTenant(testDb.db);
  statements = [];

  await testDb.ownerForTenant(tenant.tenantId, (db) =>
    db.selectFrom('notes').select('id').execute(),
  );

  // The production shape: nothing may touch a tenant table before the GUC is bound, or that
  // statement runs with whatever tenant the pooled connection last saw.
  expect(queries()[0]).toContain('set_config');
  expect(queries()[0]).toContain('app.tenant_id');
  expect(queries()[1]).toContain('from "notes"');
});

test('forTenant binds the tenant id as a parameter rather than interpolating it', async () => {
  const tenant = await seedTenant(testDb.db);
  statements = [];

  await testDb.ownerForTenant(tenant.tenantId, async () => undefined);

  // The id must not appear in the SQL text — an interpolated id would be an injection sink on
  // the one statement that defines the security boundary.
  expect(queries()[0]).not.toContain(tenant.tenantId);
  expect(queries()[0]).toContain('$1');
});

test('forTenant sets the GUC transaction-locally (is_local = true)', async () => {
  const tenant = await seedTenant(testDb.db);
  statements = [];

  await testDb.ownerForTenant(tenant.tenantId, async () => undefined);

  expect(queries()[0]).toMatch(/set_config\('app\.tenant_id', \$1, true\)/);
});

test('forTenant exposes the bound tenant id to the callback', async () => {
  const tenant = await seedTenant(testDb.db);

  const guc = await testDb.ownerForTenant(tenant.tenantId, async (db) => {
    const { rows } = await sql<{ g: string }>`SELECT current_setting('app.tenant_id') AS g`.execute(
      db,
    );
    return rows[0]?.g;
  });

  expect(guc).toBe(tenant.tenantId);
});

test('forTenant rejects a non-UUID tenant id', async () => {
  await expect(testDb.ownerForTenant('not-a-uuid', async () => 'reached')).rejects.toThrow(
    /lowercase canonical UUID/,
  );
});

test('forTenant rejects an uppercase tenant id', async () => {
  // 10-db §2: ids are lowercase canonical text. Postgres would normalise an uppercase uuid, so
  // only this boundary can hold the rule.
  await expect(
    testDb.ownerForTenant('0198F000-0000-7000-8000-0000000000FF', async () => 'reached'),
  ).rejects.toThrow(/lowercase canonical UUID/);
});

test('forTenant rejects an empty tenant id', async () => {
  await expect(testDb.ownerForTenant('', async () => 'reached')).rejects.toThrow(
    /lowercase canonical UUID/,
  );
});

test('forTenant rejects an invalid tenant id before opening a transaction', async () => {
  statements = [];
  await expect(testDb.ownerForTenant('nope', async () => 'reached')).rejects.toThrow();

  // A rejected id must not burn a pooled connection or emit a BEGIN — assert on the RAW log
  // here (not `queries()`), since "no transaction was opened" is precisely the claim.
  expect(statements).toEqual([]);
});

test('two sequential forTenant calls on the same pool each see only their own tenant', async () => {
  const a = await seedTenant(testDb.db);
  const b = await seedTenant(testDb.db);
  const aNoteId = await seedNote(testDb.db, a);
  const bNoteId = await seedNote(testDb.db, b);

  const aRows = await testDb.appForTenant(a.tenantId, (db) =>
    db.selectFrom('notes').select('id').execute(),
  );
  const bRows = await testDb.appForTenant(b.tenantId, (db) =>
    db.selectFrom('notes').select('id').execute(),
  );

  expect(aRows.map((r) => r.id)).toEqual([aNoteId]);
  expect(bRows.map((r) => r.id)).toEqual([bNoteId]);
});

test('forTenant propagates the callback result', async () => {
  const tenant = await seedTenant(testDb.db);
  const result = await testDb.ownerForTenant(tenant.tenantId, async () => 'value');
  expect(result).toBe('value');
});

test('forTenant rolls back the transaction when the callback throws', async () => {
  const tenant = await seedTenant(testDb.db);
  const noteId = await seedNote(testDb.db, tenant);

  await expect(
    testDb.ownerForTenant(tenant.tenantId, async (db) => {
      await db.updateTable('notes').set({ title: 'dirty' }).where('id', '=', noteId).execute();
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');

  const row = await testDb.db
    .selectFrom('notes')
    .select('title')
    .where('id', '=', noteId)
    .executeTakeFirstOrThrow();
  expect(row.title).not.toBe('dirty');
});
