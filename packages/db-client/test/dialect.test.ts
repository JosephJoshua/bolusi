// Dialect tests: the custom kysely-generic-sqlite shim over `DbDriver` (D6).
//
// Every assertion compares Kysely's answer against the RAW driver's answer on the SAME
// connection. That is the only way to catch a dialect that quietly drops rows, mangles
// values, or opens a second handle — a Kysely-only assertion would agree with itself.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { runClientMigrations } from '../src/migrations/runner.js';
import { openBetterSqlite3Driver } from './better-sqlite3-adapter.js';

let connection: ClientDb;

const NOTE = {
  id: 'note-1',
  tenant_id: 'tenant-1',
  store_id: 'store-1',
  title: 'Stock count',
  body: 'Twelve crates',
  media_id: null,
  created_by: 'user-1',
  created_at: 1_700_000_000_000,
  last_edited_by: 'user-1',
  last_edited_at: 1_700_000_000_000,
};

beforeEach(async () => {
  connection = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('test-key') },
    location: ':memory:',
  });
  await runClientMigrations(connection.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

test('Kysely insert is visible to the raw driver on the same connection', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();

  const raw = await connection.driver.execute(`SELECT id, title, body FROM notes`);
  expect(raw.rows).toEqual([{ id: 'note-1', title: 'Stock count', body: 'Twelve crates' }]);
});

test('Kysely select returns the same rows as the raw driver', async () => {
  await connection.driver.execute(
    `INSERT INTO notes (id, tenant_id, store_id, title, body, created_by, created_at, last_edited_by, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      NOTE.id,
      NOTE.tenant_id,
      NOTE.store_id,
      NOTE.title,
      NOTE.body,
      NOTE.created_by,
      NOTE.created_at,
      NOTE.last_edited_by,
      NOTE.last_edited_at,
    ],
  );

  const viaKysely = await connection.db
    .selectFrom('notes')
    .select(['id', 'title', 'body'])
    .execute();
  const viaDriver = await connection.driver.execute(`SELECT id, title, body FROM notes`);

  expect(viaKysely).toEqual(viaDriver.rows);
});

test('Kysely update and delete agree with the raw driver', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();

  await connection.db
    .updateTable('notes')
    .set({ title: 'Recount', edit_count: 1 })
    .where('id', '=', 'note-1')
    .execute();
  expect((await connection.driver.execute(`SELECT title, edit_count FROM notes`)).rows).toEqual([
    { title: 'Recount', edit_count: 1 },
  ]);

  await connection.db.deleteFrom('notes').where('id', '=', 'note-1').execute();
  expect((await connection.driver.execute(`SELECT COUNT(*) AS c FROM notes`)).rows).toEqual([
    { c: 0 },
  ]);
});

test('Kysely round-trips every value type the driver supports', async () => {
  await connection.db
    .insertInto('meta_kv')
    .values([
      { key: 'deviceId', value: 'device-1' },
      { key: 'tenantId', value: 'tenant-1' },
    ])
    .execute();

  const rows = await connection.db
    .selectFrom('meta_kv')
    .select(['key', 'value'])
    .orderBy('key')
    .execute();
  expect(rows).toEqual([
    { key: 'deviceId', value: 'device-1' },
    { key: 'tenantId', value: 'tenant-1' },
  ]);
});

test('a Kysely transaction rolls back on error', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();

  await expect(
    connection.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('notes')
        .values({ ...NOTE, id: 'note-2' })
        .execute();
      throw new Error('deliberate failure inside the transaction');
    }),
  ).rejects.toThrow('deliberate failure inside the transaction');

  // The rollback must be real, not just an unthrown promise.
  const rows = await connection.driver.execute(`SELECT id FROM notes ORDER BY id`);
  expect(rows.rows).toEqual([{ id: 'note-1' }]);
});

test('a Kysely transaction commits on success', async () => {
  await connection.db.transaction().execute(async (trx) => {
    await trx.insertInto('notes').values(NOTE).execute();
    await trx
      .insertInto('notes')
      .values({ ...NOTE, id: 'note-2' })
      .execute();
  });

  const rows = await connection.driver.execute(`SELECT id FROM notes ORDER BY id`);
  expect(rows.rows).toEqual([{ id: 'note-1' }, { id: 'note-2' }]);
});

test('raw sql`` SELECT returns rows through the dialect', async () => {
  // kysely-generic-sqlite's default classifier treats every RawNode as a WRITE and would
  // silently return zero rows; the shim overrides `isQuery` to fix that. This is the
  // regression test for that override.
  await connection.db.insertInto('notes').values(NOTE).execute();

  const result = await sql<{ id: string }>`SELECT id FROM notes`.execute(connection.db);
  expect(result.rows).toEqual([{ id: 'note-1' }]);
});

test('raw sql`` PRAGMA returns rows through the dialect', async () => {
  const result = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(connection.db);
  expect(result.rows).toEqual([{ foreign_keys: 1 }]);
});

test('a CHECK violation through Kysely surfaces as a typed DbError', async () => {
  await expect(
    connection.db.insertInto('sync_state').values({ id: 2, pull_cursor: 0 }).execute(),
  ).rejects.toMatchObject({ name: 'DbError', code: 'constraint' });
});
