// The connection reports when a transaction ends, so the device invalidation bus delivers a pull's
// or append's changes only then, and neither a screen nor the search cache keeps rows that were
// rolled back. Real SQLite (better-sqlite3 behind the real connection): on one
// connection a search inside an open transaction reads its uncommitted rows.
import {
  InvalidationBus,
  SearchIndexCache,
  type ChangedEntities,
  type SearchSource,
} from '@bolusi/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { createClientOpStore } from '../src/op-store.js';
import { openBetterSqlite3Driver, testAead } from './better-sqlite3-adapter.js';

let connection: ClientDb;

beforeEach(async () => {
  connection = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) },
    aead: testAead,
    location: ':memory:',
  });
  await connection.driver.execute('CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  await connection.driver.execute(`INSERT INTO people VALUES ('p1', 'Yohanis Wenda')`);
});

afterEach(async () => {
  await closeClientDb();
});

describe('transaction boundaries', () => {
  test('are reported for the transaction helper and the op store, on commit and rollback', async () => {
    const ends: boolean[] = [];
    const seen: boolean[] = [];
    connection.onTransactionEnd(() => ends.push(connection.inTransaction));
    const store = createClientOpStore(connection);

    await connection.transaction(() => Promise.resolve(seen.push(connection.inTransaction)));
    await expect(
      connection.transaction(() => {
        seen.push(connection.inTransaction);
        return Promise.reject(new Error('applier failed'));
      }),
    ).rejects.toThrow('applier failed');
    await store.transaction(() => Promise.resolve(seen.push(connection.inTransaction)));
    await expect(
      store.transaction(() => Promise.reject(new Error('genesis twice'))),
    ).rejects.toThrow('genesis twice');

    expect(seen).toEqual([true, true, true]);
    expect(ends).toEqual([false, false, false, false]);
    expect(connection.inTransaction).toBe(false);
  });

  test('the bus delivers changes made in a transaction once it ends, committed or not', async () => {
    const bus = new InvalidationBus(connection);
    const reads: string[][] = [];
    // A screen's live query: re-read the table whenever it changes.
    bus.subscribeTable('people', () => {
      void connection.driver
        .execute('SELECT name FROM people ORDER BY id')
        .then(({ rows }) => reads.push(rows.map((row) => String(row.name))));
    });
    const write = async (id: string, name: string) => {
      await connection.driver.execute('INSERT OR REPLACE INTO people VALUES (?, ?)', [id, name]);
      bus.emit(new Set(['people']), { entityType: 'person', entityId: id });
    };

    await connection.transaction(async () => {
      await write('p2', 'Maria Kogoya');
      expect(reads).toEqual([]);
    });
    await expect(
      connection.transaction(async () => {
        await write('p3', 'Siti Rumbiak');
        throw new Error('bad signature in batch');
      }),
    ).rejects.toThrow('bad signature in batch');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reads).toEqual([
      ['Yohanis Wenda', 'Maria Kogoya'],
      ['Yohanis Wenda', 'Maria Kogoya'],
    ]);
  });

  test('a throwing listener does not fail the commit', async () => {
    connection.onTransactionEnd(() => {
      throw new Error('listener bug');
    });
    await expect(connection.transaction(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('device search cache over the connection', () => {
  const source: SearchSource<never> = {
    name: 'test.people',
    tables: ['people'],
    entityTypes: ['person'],
    async loadAll() {
      const { rows } = await connection.driver.execute('SELECT id, name FROM people');
      return rows.map((row) => ({ id: String(row.id), text: [String(row.name)], rank: 0 }));
    },
    async loadChanged(_db: unknown, _scope: unknown, changed: ChangedEntities) {
      const ids = changed.get('person') ?? [];
      const documents = [];
      for (const id of ids) {
        const { rows } = await connection.driver.execute('SELECT name FROM people WHERE id = ?', [
          id,
        ]);
        if (rows[0] !== undefined) documents.push({ id, text: [String(rows[0].name)], rank: 0 });
      }
      return { documents, checked: ids };
    },
  };

  function setup() {
    const bus = new InvalidationBus(connection);
    const cache = new SearchIndexCache(bus);
    const search = async (text: string) =>
      (await cache.index(source, {} as never, { tenantId: 't1', storeId: 's1' }))
        .search(text, 10)
        .map((hit) => hit.id);
    // What the projection engine does after applying an op, inside the op's transaction.
    const write = async (id: string, name: string) => {
      await connection.driver.execute('INSERT OR REPLACE INTO people VALUES (?, ?)', [id, name]);
      bus.emit(new Set(['people']), { entityType: 'person', entityId: id });
    };
    return { search, write };
  }

  test('a pull batch that rolls back leaves nothing in the index, even what a search read mid-batch', async () => {
    const { search, write } = setup();
    expect(await search('yohanis')).toEqual(['p1']);
    await write('p1', 'Yohanes Wonda'); // committed on its own

    await expect(
      connection.transaction(async () => {
        await write('p1', 'Kristian Wonda');
        await write('p3', 'Siti Rumbiak');
        // A search while the batch is open reloads p1 and reads the uncommitted name.
        expect(await search('kristian')).toEqual(['p1']);
        throw new Error('bad signature in batch');
      }),
    ).rejects.toThrow('bad signature in batch');

    expect(await search('kristian')).toEqual([]);
    expect(await search('rumbiak')).toEqual([]);
    expect(await search('yohanes')).toEqual(['p1']);
  });

  test('a committed batch is searchable once it commits', async () => {
    const { search, write } = setup();
    await search('x');
    await connection.transaction(async () => {
      await write('p3', 'Siti Rumbiak');
      expect(await search('rumbiak')).toEqual([]);
    });
    expect(await search('rumbiak')).toEqual(['p3']);
  });
});
