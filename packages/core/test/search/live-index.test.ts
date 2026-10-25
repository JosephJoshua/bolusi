// The device cache loads a source once, then reloads only the entities the projection reports.
import { describe, expect, test } from 'vitest';

import { InvalidationBus } from '../../src/projection/invalidation.js';
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

  async loadAll(): Promise<readonly SearchDocument[]> {
    this.loads += 1;
    await Promise.resolve();
    return [...this.rows].map(([id, name]) => this.doc(id, name));
  }

  async loadChanged(_db: unknown, _scope: unknown, changed: ChangedEntities) {
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
}

const db = {} as ReadonlyProjectionDb<never>;
const scope = { tenantId: 't1', storeId: 's1' };
const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id);

function setup() {
  const bus = new InvalidationBus();
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

  test('stores are indexed separately', async () => {
    const { cache, source } = setup();
    await cache.index(source, db, scope);
    await cache.index(source, db, { tenantId: 't1', storeId: 's2' });
    expect(source.loads).toBe(2);
  });
});
