// Transactions on the one connection take turns (connection.ts `serializeTransactions`). The append
// path, the pull and a background rebuild batch each open their own transaction on the same handle;
// before the queue, the second BEGIN failed ("cannot start a transaction within a transaction") and a
// rollback could discard another caller's writes. Real better-sqlite3, because those are SQLite's own
// errors, not a fake's.
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { openTestDriver, testAead, testKeyStore } from './better-sqlite3-adapter.js';

let connection: ClientDb;

beforeEach(async () => {
  connection = await openClientDb({
    driverFactory: openTestDriver,
    keyStore: testKeyStore,
    aead: testAead,
  });
  await connection.driver.execute('CREATE TABLE t (label TEXT NOT NULL)');
});

afterEach(async () => {
  await closeClientDb();
});

/** Yields to the event loop so an overlapping caller gets the chance to run. */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function labels(): Promise<string[]> {
  const result = await connection.driver.execute('SELECT label FROM t ORDER BY rowid');
  return result.rows.map((row) => String(row['label']));
}

test('overlapping transactions run one after another and all commit', async () => {
  const order: string[] = [];
  const writer = (label: string) =>
    connection.transaction(async (driver) => {
      order.push(`${label}:start`);
      await driver.execute('INSERT INTO t (label) VALUES (?)', [label]);
      await yieldTurn();
      order.push(`${label}:end`);
    });

  await Promise.all([writer('a'), writer('b'), writer('c')]);

  expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  expect(await labels()).toEqual(['a', 'b', 'c']);
});

test('a Kysely transaction queues behind a driver transaction instead of failing', async () => {
  const driverSide = connection.transaction(async (driver) => {
    await driver.execute('INSERT INTO t (label) VALUES (?)', ['driver']);
    await yieldTurn();
  });
  const kyselySide = connection.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO t (label) VALUES (${'kysely'})`.execute(trx);
  });

  await Promise.all([driverSide, kyselySide]);
  expect(await labels()).toEqual(['driver', 'kysely']);
});

test("one caller's rollback discards only its own writes and frees the connection", async () => {
  const failing = connection.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO t (label) VALUES (${'rolled back'})`.execute(trx);
    await yieldTurn();
    throw new Error('applier failed');
  });
  const succeeding = connection.transaction(async (driver) => {
    await driver.execute('INSERT INTO t (label) VALUES (?)', ['kept']);
  });

  await expect(failing).rejects.toThrow('applier failed');
  await succeeding;
  expect(await labels()).toEqual(['kept']);

  // The queue is free again: a later transaction starts without waiting on anything.
  await connection.transaction(async (driver) => {
    await driver.execute('INSERT INTO t (label) VALUES (?)', ['after']);
  });
  expect(await labels()).toEqual(['kept', 'after']);
});

test('a failed BEGIN does not hold the queue', async () => {
  // A raw BEGIN underneath the queue makes the queued BEGIN fail with SQLite's own error.
  await connection.driver.execute('BEGIN');
  await expect(connection.transaction(() => Promise.resolve())).rejects.toThrow(/transaction/);
  await connection.driver.execute('ROLLBACK');

  await connection.transaction(async (driver) => {
    await driver.execute('INSERT INTO t (label) VALUES (?)', ['next']);
  });
  expect(await labels()).toEqual(['next']);
});

test('a Kysely transaction reports its end, before the next queued transaction begins', async () => {
  const order: string[] = [];
  connection.onTransactionEnd(() => order.push(`end:${String(connection.inTransaction)}`));

  let driverSide: Promise<void> = Promise.resolve();
  const kyselySide = connection.db.transaction().execute(async (trx) => {
    order.push(`kysely:${String(connection.inTransaction)}`);
    // Queued while the Kysely transaction is open: it must wait for that one's end.
    driverSide = connection.transaction(async () => {
      order.push('driver');
    });
    await sql`INSERT INTO t (label) VALUES (${'kysely'})`.execute(trx);
    await yieldTurn();
  });

  await kyselySide;
  await driverSide;
  expect(order).toEqual(['kysely:true', 'end:false', 'driver', 'end:false']);
});
