// Dialect tests: the custom kysely-generic-sqlite shim over `DbDriver` (D6).
//
// Every assertion compares Kysely's answer against the RAW driver's answer on the SAME
// connection. That is the only way to catch a dialect that quietly drops rows, mangles
// values, or opens a second handle — a Kysely-only assertion would agree with itself.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { runClientMigrations } from '../src/migrations/runner.js';
import { COLUMN_CIPHER_SCHEME_PREFIX } from '../src/crypto/column-cipher.js';
import { openBetterSqlite3Driver, testAead, testKeyStore } from './better-sqlite3-adapter.js';

let connection: ClientDb;

// camelCase identifiers: CamelCasePlugin is wired into the client Kysely (10-db §11.4),
// so the query builder speaks camelCase while the DDL and the raw driver stay snake_case.
const NOTE = {
  id: 'note-1',
  tenantId: 'tenant-1',
  storeId: 'store-1',
  title: 'Stock count',
  body: 'Twelve crates',
  mediaId: null,
  createdBy: 'user-1',
  createdAt: 1_700_000_000_000,
  lastEditedBy: 'user-1',
  lastEditedAt: 1_700_000_000_000,
};

beforeEach(async () => {
  connection = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: testKeyStore,
    aead: testAead,
    location: ':memory:',
  });
  await runClientMigrations(connection.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

test('Kysely insert is visible to the raw driver on the same connection', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();

  // ONE connection: the row the Kysely handle wrote is the row the raw driver reads.
  const raw = await connection.driver.execute(`SELECT id, title, body FROM notes`);
  expect(raw.rows).toHaveLength(1);
  expect(raw.rows[0]?.['id']).toBe('note-1');

  // …but `notes.title`/`body` are D22 at-rest-encrypted columns, and the RAW driver sits BELOW the
  // decrypt seam (which is a Kysely plugin). So what is physically stored is ciphertext — the whole
  // point of the control. This is the same-connection visibility assertion AND the at-rest one.
  expect(raw.rows[0]?.['title']).not.toBe('Stock count');
  expect(raw.rows[0]?.['body']).not.toBe('Twelve crates');
  expect(String(raw.rows[0]?.['title']).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
  expect(String(raw.rows[0]?.['body']).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);

  // Read back THROUGH Kysely and the plaintext returns — the transform is transparent to callers.
  const viaKysely = await connection.db
    .selectFrom('notes')
    .select(['id', 'title', 'body'])
    .execute();
  expect(viaKysely).toEqual([{ id: 'note-1', title: 'Stock count', body: 'Twelve crates' }]);
});

// The identifier contract 04 §2 depends on: ONE applier, written in camelCase, lands in
// the snake_case columns of 10-db §9 on this engine — and the server's CamelCasePlugin
// does the same over the same column names. If this mapping breaks, appliers silently
// write nothing on one of the two engines.
test('camelCase identifiers map to the snake_case DDL columns and back', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();

  // Raw SQL bypasses Kysely entirely: it must find the values under snake_case columns.
  const raw = await connection.driver.execute(
    `SELECT tenant_id, store_id, created_by, last_edited_at, edit_count FROM notes`,
  );
  expect(raw.rows).toEqual([
    {
      tenant_id: 'tenant-1',
      store_id: 'store-1',
      created_by: 'user-1',
      last_edited_at: 1_700_000_000_000,
      edit_count: 0,
    },
  ]);

  // ...and reading back through Kysely re-camelizes the result keys.
  const viaKysely = await connection.db
    .selectFrom('notes')
    .select(['tenantId', 'storeId', 'createdBy', 'lastEditedAt', 'editCount'])
    .execute();
  expect(viaKysely).toEqual([
    {
      tenantId: 'tenant-1',
      storeId: 'store-1',
      createdBy: 'user-1',
      lastEditedAt: 1_700_000_000_000,
      editCount: 0,
    },
  ]);
});

test('a camelCase WHERE clause filters on the snake_case column', async () => {
  await connection.db.insertInto('notes').values(NOTE).execute();
  await connection.db
    .insertInto('notes')
    .values({ ...NOTE, id: 'note-2', storeId: 'store-2' })
    .execute();

  const rows = await connection.db
    .selectFrom('notes')
    .select('id')
    .where('storeId', '=', 'store-2')
    .execute();
  expect(rows).toEqual([{ id: 'note-2' }]);
});

test('Kysely select returns the same rows as the raw driver', async () => {
  await connection.driver.execute(
    `INSERT INTO notes (id, tenant_id, store_id, title, body, created_by, created_at, last_edited_by, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      NOTE.id,
      NOTE.tenantId,
      NOTE.storeId,
      NOTE.title,
      NOTE.body,
      NOTE.createdBy,
      NOTE.createdAt,
      NOTE.lastEditedBy,
      NOTE.lastEditedAt,
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
    .set({ title: 'Recount', editCount: 1 })
    .where('id', '=', 'note-1')
    .execute();

  // `edit_count` is plaintext, so the raw driver reads it verbatim; `title` is an encrypted column, so
  // the UPDATE stored ciphertext (the encrypt seam covers UPDATE, not only INSERT — a title that
  // round-tripped in the clear on edit would be a silent leak on every note rename).
  const raw = await connection.driver.execute(`SELECT title, edit_count FROM notes`);
  expect(raw.rows[0]?.['edit_count']).toBe(1);
  expect(raw.rows[0]?.['title']).not.toBe('Recount');
  expect(String(raw.rows[0]?.['title']).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
  expect(await connection.db.selectFrom('notes').select('title').execute()).toEqual([
    { title: 'Recount' },
  ]);

  await connection.db.deleteFrom('notes').where('id', '=', 'note-1').execute();
  expect((await connection.driver.execute(`SELECT COUNT(*) AS c FROM notes`)).rows).toEqual([
    { c: 0 },
  ]);
});

test('Kysely round-trips every value type the driver supports', async () => {
  await connection.db
    .insertInto('metaKv')
    .values([
      { key: 'deviceId', value: 'device-1' },
      { key: 'tenantId', value: 'tenant-1' },
    ])
    .execute();

  const rows = await connection.db
    .selectFrom('metaKv')
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

test('raw sql`` PRAGMA returns rows through the dialect, with camelized result keys', async () => {
  // Gotcha worth pinning: CamelCasePlugin does NOT rewrite identifiers inside a raw sql``
  // fragment (`foreign_keys` stays as written), but it DOES map the RESULT keys — so the
  // row comes back as `foreignKeys`. Callers reaching for raw SQL through Kysely must
  // expect camelCase out; the raw driver (connection.driver) is the snake_case path.
  const result = await sql<{ foreignKeys: number }>`PRAGMA foreign_keys`.execute(connection.db);
  expect(result.rows).toEqual([{ foreignKeys: 1 }]);
});

test('a CHECK violation through Kysely surfaces as a typed DbError', async () => {
  await expect(
    connection.db.insertInto('syncState').values({ id: 2, pullCursor: 0 }).execute(),
  ).rejects.toMatchObject({ name: 'DbError', code: 'constraint' });
});
