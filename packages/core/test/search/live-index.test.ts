// The device cache loads a source once, then reloads only the entities the projection reports.
import { describe, expect, test } from 'vitest';

import { InvalidationBus, type TransactionBoundaries } from '../../src/projection/invalidation.js';
import type { ReadonlyProjectionDb } from '../../src/query/qctx.js';
import {
  SearchIndexCache,
  type ChangedEntities,
  type SearchDocument,
  type SearchSource,
} from '../../src/search/index.js';

class FakeSource implements SearchSource<never> {
  readonly name = 'test.people';
  readonly tables = ['people'];
  readonly entityTypes = ['person'];
  readonly rows = new Map<string, string>();
  loads = 0;
  changes: Record<string, string[]>[] = [];
  failNext = false;
  /** When set, the next load waits for it: a slow disk, so searches pile up behind it. */
  gate: Promise<void> | null = null;

  async loadAll(): Promise<readonly SearchDocument[]> {
    this.loads += 1;
    await this.#wait();
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk busy');
    }
    return [...this.rows].map(([id, name]) => this.doc(id, name));
  }

  async loadChanged(_db: unknown, _scope: unknown, changed: ChangedEntities) {
    await this.#wait();
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk busy');
    }
    this.changes.push(
      Object.fromEntries([...changed].map(([type, ids]) => [type, [...ids].sort()])),
    );
    const ids = changed.get('person') ?? [];
    const documents = ids.flatMap((id) => {
      const name = this.rows.get(id);
      return name === undefined ? [] : [this.doc(id, name)];
    });
    return { documents, checked: ids };
  }

  doc(id: string, name: string): SearchDocument {
    return { id, text: [name], rank: 0 };
  }

  async #wait(): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    await (gate ?? Promise.resolve());
  }

  /** Hold the next load until the returned function is called. */
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((resolve) => (release = resolve));
    return release;
  }
}

/** The connection's transaction boundaries, driven by hand. */
class FakeTransactions implements TransactionBoundaries {
  inTransaction = false;
  readonly #listeners = new Set<() => void>();

  onTransactionEnd(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  begin(): void {
    this.inTransaction = true;
  }

  end(): void {
    this.inTransaction = false;
    for (const listener of this.#listeners) listener();
  }
}

const db = {} as ReadonlyProjectionDb<never>;
const scope = { tenantId: 't1', storeId: 's1' };
const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id);

function setup(transactions?: TransactionBoundaries) {
  const bus = new InvalidationBus(transactions);
  const cache = new SearchIndexCache(bus);
  const source = new FakeSource();
  source.rows.set('p1', 'Yohanis Wenda');
  source.rows.set('p2', 'Maria Kogoya');
  const search = async (text: string) =>
    ids((await cache.index(source, db, scope)).search(text, 10));
  const change = (entityId: string, entityType = 'person') =>
    bus.emit(new Set(['people']), { entityType, entityId });
  return { bus, cache, source, search, change };
}

describe('SearchIndexCache', () => {
  test('loads once, then serves from memory while nothing changes', async () => {
    const { source, search } = setup();
    expect(await search('yohanis')).toEqual(['p1']);
    expect(await search('maria')).toEqual(['p2']);
    expect(source.loads).toBe(1);
    expect(source.changes).toEqual([]);
  });

  test('reloads only the entities that changed: added, corrected and removed', async () => {
    const { source, search, change } = setup();
    await search('x');
    source.rows.set('p3', 'Siti Rumbiak');
    source.rows.set('p1', 'Yohanes Wonda');
    source.rows.delete('p2');
    change('p3');
    change('p1');
    change('p2');
    change('p1');
    expect(await search('rumbiak')).toEqual(['p3']);
    expect(await search('wonda')).toEqual(['p1']);
    expect(await search('wenda')).toEqual(['p1']); // still close enough: one typo away
    expect(await search('kogoya')).toEqual([]);
    expect(source.loads).toBe(1);
    expect(source.changes).toEqual([{ person: ['p1', 'p2', 'p3'] }]);
  });

  test('ignores entity types the source does not index', async () => {
    const { source, search, change } = setup();
    await search('x');
    change('n1', 'note');
    await search('x');
    expect(source.changes).toEqual([]);
  });

  test('a rebuild batch (tables, no entity) on its tables reloads everything', async () => {
    const { bus, source, search } = setup();
    await search('x');
    bus.emit(new Set(['unrelated']));
    await search('x');
    expect(source.loads).toBe(1);
    source.rows.set('p9', 'Petrus Mofu');
    bus.emit(new Set(['people', 'unrelated']));
    expect(await search('petrus')).toEqual(['p9']);
    expect(source.loads).toBe(2);
  });

  test('a failed reload keeps the changes for the next search', async () => {
    const { source, search, change } = setup();
    await search('x');
    source.rows.set('p3', 'Siti Rumbiak');
    change('p3');
    source.failNext = true;
    await expect(search('rumbiak')).rejects.toThrow('disk busy');
    expect(await search('rumbiak')).toEqual(['p3']);
  });

  test('concurrent first searches share one load', async () => {
    const { source, search } = setup();
    await Promise.all([search('a'), search('b'), search('c')]);
    expect(source.loads).toBe(1);
  });

  test('a search waiting behind a refresh also waits for the next one another waiter starts', async () => {
    const { source, search, change } = setup();
    await search('x');
    source.rows.set('p3', 'Siti Rumbiak');
    change('p3');
    const release = source.hold();
    const first = search('rumbiak');
    // A sync lands p4 while that reload is on disk, and two searches queue behind it.
    source.rows.set('p4', 'Agus Rumbiak');
    change('p4');
    const second = search('rumbiak');
    const third = search('rumbiak');
    release();
    expect((await first).sort()).toEqual(['p3']);
    // One of them reloads p4; the other must wait for that reload instead of answering without it.
    expect((await second).sort()).toEqual(['p3', 'p4']);
    expect((await third).sort()).toEqual(['p3', 'p4']);
    expect(source.changes).toEqual([{ person: ['p3'] }, { person: ['p4'] }]);
  });

  test('searches queued behind a failed first build share one retry', async () => {
    const { source, search } = setup();
    source.failNext = true;
    const release = source.hold();
    const first = search('yohanis');
    const others = Promise.all([search('yohanis'), search('maria')]);
    release();
    await expect(first).rejects.toThrow('disk busy');
    expect(await others).toEqual([['p1'], ['p2']]);
    expect(source.loads).toBe(2);
  });

  test('changes inside an open transaction wait for it to end', async () => {
    const transactions = new FakeTransactions();
    const { source, search, change } = setup(transactions);
    await search('x');
    transactions.begin();
    source.rows.set('p3', 'Siti Rumbiak');
    change('p3');
    // Mid-transaction, the uncommitted row is not read.
    expect(await search('rumbiak')).toEqual([]);
    expect(source.changes).toEqual([]);
    transactions.end(); // committed
    expect(await search('rumbiak')).toEqual(['p3']);
  });

  test('a rolled-back transaction leaves no trace, even of rows a search read mid-transaction', async () => {
    const transactions = new FakeTransactions();
    const { source, search, change } = setup(transactions);
    await search('x');
    source.rows.set('p1', 'Yohanes Wonda');
    change('p1'); // committed earlier, not yet reloaded
    transactions.begin();
    source.rows.set('p1', 'Kristian Wonda'); // the open transaction edits it again
    source.rows.set('p3', 'Siti Rumbiak');
    change('p1');
    change('p3');
    // This search reloads p1 and reads the uncommitted edit.
    expect(await search('kristian')).toEqual(['p1']);
    source.rows.set('p1', 'Yohanes Wonda'); // rollback
    source.rows.delete('p3');
    transactions.end();
    expect(await search('kristian')).toEqual([]);
    expect(await search('yohanes')).toEqual(['p1']);
    expect(await search('rumbiak')).toEqual([]);
  });

  test('stores are indexed separately', async () => {
    const { cache, source } = setup();
    await cache.index(source, db, scope);
    await cache.index(source, db, { tenantId: 't1', storeId: 's2' });
    expect(source.loads).toBe(2);
  });
});
