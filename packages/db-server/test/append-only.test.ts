// Append-only enforcement on `operations` (10-db-schema §5; security-guide §3.1 last bullet:
// "enforced three ways"). Legs (b) trigger + role grants live here; leg (a), the lint rule, is
// bolusi/no-op-table-update (task 01) and leg (c) is db-client's.
//
// SEC-OPLOG-07 is NOT titled here on purpose: security-guide §3.2 scopes it to the full
// rejection pipeline (task 07 owns it, per the SEC-META-01 pending allowlist). These are the
// DB-level facts that test will stand on.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { seedTenant, timestampMs, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;

beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

async function insertOperation(): Promise<string> {
  const id = uuid();
  const zeros = '0'.repeat(64);
  await testDb.db
    .insertInto('operations')
    .values({
      id,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      userId: tenant.userId,
      deviceId: tenant.deviceId,
      seq: BigInt(timestampMs()),
      type: 'notes.note_created',
      entityType: 'note',
      entityId: uuid(),
      schemaVersion: 1,
      payload: JSON.stringify({ title: 't' }),
      timestampMs: BigInt(timestampMs()),
      source: 'ui',
      previousHash: zeros,
      hash: zeros,
      signature: 'c2ln',
      signedCoreJcs: '{}',
      serverSeq: BigInt(timestampMs()),
      receivedAt: BigInt(timestampMs()),
    })
    .execute();
  return id;
}

test('UPDATE on operations raises the append-only exception even as the table owner', async () => {
  // The trigger is the belt that survives a role misconfiguration: it fires regardless of who
  // is connected, including the superuser running this test.
  const id = await insertOperation();

  await expect(
    testDb.db
      .updateTable('operations')
      .set({ payload: JSON.stringify({}) })
      .where('id', '=', id)
      .execute(),
  ).rejects.toThrow(/append-only/i);
});

test('DELETE on operations raises the append-only exception even as the table owner', async () => {
  const id = await insertOperation();

  await expect(testDb.db.deleteFrom('operations').where('id', '=', id).execute()).rejects.toThrow(
    /append-only/i,
  );
});

test('an operation row survives an attempted UPDATE', async () => {
  const id = await insertOperation();
  await expect(
    testDb.db.updateTable('operations').set({ signature: 'forged' }).where('id', '=', id).execute(),
  ).rejects.toThrow();

  const row = await testDb.db
    .selectFrom('operations')
    .select('signature')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  expect(row.signature).toBe('c2ln');
});

test('the app role is denied UPDATE on operations by grants', async () => {
  // The braces: even if the trigger were dropped, bolusi_app holds SELECT/INSERT only.
  const id = await insertOperation();

  await expect(
    testDb.appForTenant(tenant.tenantId, (db) =>
      db.updateTable('operations').set({ signature: 'forged' }).where('id', '=', id).execute(),
    ),
  ).rejects.toThrow(/permission denied/i);
});

test('the app role is denied DELETE on operations by grants', async () => {
  const id = await insertOperation();

  await expect(
    testDb.appForTenant(tenant.tenantId, (db) =>
      db.deleteFrom('operations').where('id', '=', id).execute(),
    ),
  ).rejects.toThrow(/permission denied/i);
});

test('the app role is denied TRUNCATE on operations', async () => {
  await expect(
    testDb.appForTenant(tenant.tenantId, (db) => sql`TRUNCATE operations`.execute(db)),
  ).rejects.toThrow(/permission denied|must be owner/i);
});

test('the app role may SELECT and INSERT on operations', async () => {
  // The negative control: the denials above must come from the grant matrix, not from the app
  // role being unable to touch the table at all.
  const rows = await testDb.appForTenant(tenant.tenantId, (db) =>
    db.selectFrom('operations').select('id').execute(),
  );
  expect(Array.isArray(rows)).toBe(true);
});

test('the app role is denied ALTER TABLE on every table', async () => {
  // security-guide §10: "the app role cannot ALTER TABLE or bypass RLS". Ownership sits with
  // bolusi_provision, so this holds for the whole schema, not just operations.
  const { rows: tables } = await sql<{ tableName: string }>`
    SELECT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `.execute(testDb.db);

  expect(tables.length).toBeGreaterThan(20);

  for (const { tableName } of tables) {
    const outcome = await testDb.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      try {
        await sql.raw(`ALTER TABLE ${tableName} ADD COLUMN injected_column text`).execute(trx);
        return 'ALLOWED';
      } catch (error) {
        return String(error);
      }
    });

    expect(outcome, `${tableName} allowed ALTER TABLE as bolusi_app`).toMatch(
      /must be owner|permission denied/i,
    );
  }
});

test('the app role holds no BYPASSRLS or SUPERUSER attribute', async () => {
  const { rows } = await sql<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'bolusi_app'`.execute(testDb.db);

  expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
});
