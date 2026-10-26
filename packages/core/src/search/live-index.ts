// Search indexes kept current on the device, one per search source per store.
//
// A module declares a `SearchSource`: how to load its documents, and which entity changes can
// alter them. The first search builds the index from `loadAll` (decrypting the store's rows once).
// After that, every applied op, local or pulled, reports the entity it changed on the projection
// engine's invalidation bus; the cache notes the id, and the next search reloads only those
// entities through `loadChanged` before answering. Nothing is re-read or re-decrypted per
// keystroke, and a sync that brings in 200 ops costs 200 small reloads, not a rebuild.
//
// On the device the bus delivers an op's change only once its transaction has ended
// (projection/invalidation.ts), so the next search reloads rows that are final: the new ones after
// a commit, the old ones after a rollback, which also undoes anything a search read mid-transaction.
// A rebuild batch reports tables but no entity, so a source touching those tables reloads in full.
//
// Without a cache (the server, tests), `searchIndexFor` builds a throwaway index per query: the
// same matching and ranking, just not kept.
import type { EntityChange, InvalidationBus } from '../projection/invalidation.js';
import type { QueryContext, ReadonlyProjectionDb } from '../query/qctx.js';
import type { SearchDocument } from './fuzzy.js';
import { FuzzyIndex } from './fuzzy-index.js';

export interface SearchScope {
  readonly tenantId: string;
  readonly storeId: string | null;
}

/** The entities that changed since the last refresh, by entity type. */
export type ChangedEntities = ReadonlyMap<string, readonly string[]>;

export interface SearchSource<DB> {
  /** Unique across modules, e.g. `repair.tickets`. */
  readonly name: string;
  /** Projection tables whose writes can change these documents (for rebuild batches). */
  readonly tables: readonly string[];
  /** Entity types whose ops can change these documents. */
  readonly entityTypes: readonly string[];
  loadAll(db: ReadonlyProjectionDb<DB>, scope: SearchScope): Promise<readonly SearchDocument[]>;
  /**
   * Reload what the changed entities may affect. `checked` lists the document ids looked at; one
   * that is checked but not returned no longer exists and is removed.
   */
  loadChanged(
    db: ReadonlyProjectionDb<DB>,
    scope: SearchScope,
    changed: ChangedEntities,
  ): Promise<{
    readonly documents: readonly SearchDocument[];
    readonly checked: readonly string[];
  }>;
}

interface CacheEntry {
  readonly source: SearchSource<never>;
  index: FuzzyIndex | null;
  /** True when a rebuild batch touched the source's tables: reload everything. */
  stale: boolean;
  dirty: Map<string, Set<string>>;
  /** The refresh in flight, so concurrent searches share one load. */
  pending: Promise<FuzzyIndex> | null;
}

export class SearchIndexCache {
  readonly #entries = new Map<string, CacheEntry>();

  constructor(invalidation: InvalidationBus) {
    invalidation.subscribe((tables, change) => this.#noteChange(tables, change));
  }

  #noteChange(tables: ReadonlySet<string>, change: EntityChange | undefined): void {
    for (const entry of this.#entries.values()) {
      if (change !== undefined) {
        if (!entry.source.entityTypes.includes(change.entityType)) continue;
        let ids = entry.dirty.get(change.entityType);
        if (ids === undefined) entry.dirty.set(change.entityType, (ids = new Set()));
        ids.add(change.entityId);
      } else if (entry.source.tables.some((table) => tables.has(table))) {
        entry.stale = true;
      }
    }
  }

  /** The source's index for this store, refreshed with every change noted since the last call. */
  index<DB>(
    source: SearchSource<DB>,
    db: ReadonlyProjectionDb<DB>,
    scope: SearchScope,
  ): Promise<FuzzyIndex> {
    const key = `${source.name}\u0000${scope.tenantId}\u0000${scope.storeId ?? ''}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = {
        source: source as unknown as SearchSource<never>,
        index: null,
        stale: true,
        dirty: new Map(),
        pending: null,
      };
      this.#entries.set(key, entry);
    }
    const current = entry;
    const run = async (): Promise<FuzzyIndex> => {
      // Wait out every refresh in flight, not just the first: another waiter may start the next one
      // while this one sleeps, and returning before it lands would miss the changes it took.
      while (current.pending !== null) await current.pending.catch(() => undefined);
      if (current.index !== null && !current.stale && current.dirty.size === 0) {
        return current.index;
      }
      // No await between the check above and claiming `pending`, so only one waiter refreshes.
      const refresh: Promise<FuzzyIndex> = this.#refresh(current, source, db, scope).finally(() => {
        if (current.pending === refresh) current.pending = null;
      });
      current.pending = refresh;
      return refresh;
    };
    return run();
  }

  async #refresh<DB>(
    entry: CacheEntry,
    source: SearchSource<DB>,
    db: ReadonlyProjectionDb<DB>,
    scope: SearchScope,
  ): Promise<FuzzyIndex> {
    // Take the noted changes before reading, so ones noted during the read wait for next time.
    const dirty = entry.dirty;
    entry.dirty = new Map();
    if (entry.index === null || entry.stale) {
      entry.stale = false;
      try {
        entry.index = new FuzzyIndex(await source.loadAll(db, scope));
      } catch (error) {
        entry.stale = true;
        throw error;
      }
      return entry.index;
    }
    const index = entry.index;
    try {
      const changed = new Map([...dirty].map(([type, ids]) => [type, [...ids]] as const));
      const { documents, checked } = await source.loadChanged(db, scope, changed);
      const found = new Set<string>();
      for (const doc of documents) {
        index.upsert(doc);
        found.add(doc.id);
      }
      for (const id of checked) if (!found.has(id)) index.remove(id);
    } catch (error) {
      // Put the changes back so the next search retries them.
      for (const [type, ids] of dirty) {
        let pending = entry.dirty.get(type);
        if (pending === undefined) entry.dirty.set(type, (pending = new Set()));
        for (const id of ids) pending.add(id);
      }
      throw error;
    }
    return index;
  }
}

/** The index for `source` in the query's store: from the device cache, or built for this query. */
export async function searchIndexFor<DB>(
  qctx: QueryContext<DB>,
  source: SearchSource<DB>,
): Promise<FuzzyIndex> {
  const scope = { tenantId: qctx.tenantId, storeId: qctx.storeId };
  if (qctx.search !== undefined) return qctx.search.index(source, qctx.db, scope);
  return new FuzzyIndex(await source.loadAll(qctx.db, scope));
}
