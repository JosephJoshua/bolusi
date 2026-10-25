// Live-query invalidation bus (04-module-contract §7).
//
// After ops apply, subscribed live queries must re-run when their declared projection tables
// intersect the tables the applied ops WROTE. This bus delivers that signal at PER-TABLE
// granularity with NO row payload (04 §7: no row diffing in v0). The engine fires it after
// every head-apply, re-fold, and rebuild batch; the query layer (task 15) owns the
// table-intersection test. Untouched tables stay silent.
//
// Delivery is synchronous: the engine fires inside the same tick after a write, so a screen's
// re-query is scheduled promptly. Listeners must not throw — a throwing listener would abort
// the fire loop; the engine treats emission as best-effort notification, never a write path.
//
// The engine fires while the op's transaction is still open. On the device's one connection a
// listener reading then would see uncommitted rows, and keep them if the transaction rolls back.
// So the device bus is given the connection's transaction boundaries and holds what is emitted
// inside a transaction until it ends, then delivers it: after a commit listeners read the new rows,
// after a rollback they read the old ones back.

/**
 * The entity one applied op changed. Row data never travels (04 §7); the id lets a cache refresh
 * just that entity instead of re-reading whole tables (search/live-index.ts). Absent for a
 * rebuild batch, which may have touched anything in its tables.
 */
export interface EntityChange {
  readonly entityType: string;
  readonly entityId: string;
}

/** A change notification carrying the set of tables written and, per op, the entity changed. */
export type InvalidationListener = (tables: ReadonlySet<string>, change?: EntityChange) => void;

/** Fires when a SPECIFIC table is among those written. */
export type TableInvalidationListener = () => void;

/** Transaction boundaries on the connection the ops are applied through. */
export interface TransactionBoundaries {
  /** True between a begin and its commit or rollback. */
  readonly inTransaction: boolean;
  /** Calls `listener` after every commit or rollback. Returns unsubscribe. */
  onTransactionEnd(listener: () => void): () => void;
}

export class InvalidationBus {
  private readonly all = new Set<InvalidationListener>();
  private readonly perTable = new Map<string, Set<TableInvalidationListener>>();
  /** Emitted inside the open transaction, delivered once it ends. */
  private readonly held: Array<readonly [ReadonlySet<string>, EntityChange | undefined]> = [];

  /** Without `transactions` (the server, tests) every emission is delivered at once. */
  constructor(private readonly transactions?: TransactionBoundaries) {
    transactions?.onTransactionEnd(() => {
      for (const [tables, change] of this.held.splice(0)) this.deliver(tables, change);
    });
  }

  /** Subscribe to every emission (receives the full written-table set). Returns unsubscribe. */
  subscribe(listener: InvalidationListener): () => void {
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  /** Subscribe to a single table's changes. Returns unsubscribe. */
  subscribeTable(table: string, listener: TableInvalidationListener): () => void {
    let set = this.perTable.get(table);
    if (set === undefined) {
      set = new Set();
      this.perTable.set(table, set);
    }
    set.add(listener);
    return () => {
      const current = this.perTable.get(table);
      current?.delete(listener);
      if (current !== undefined && current.size === 0) this.perTable.delete(table);
    };
  }

  /**
   * Emit for the tables written by an apply/re-fold/rebuild batch. Fires each per-table
   * listener ONCE for its table (per-table granularity) and every all-tables listener once
   * with the set. An empty set is a no-op — nothing was written, nothing is signalled.
   */
  emit(tables: ReadonlySet<string>, change?: EntityChange): void {
    if (tables.size === 0) return;
    if (this.transactions?.inTransaction === true) this.held.push([tables, change]);
    else this.deliver(tables, change);
  }

  private deliver(tables: ReadonlySet<string>, change: EntityChange | undefined): void {
    for (const table of tables) {
      const listeners = this.perTable.get(table);
      if (listeners === undefined) continue;
      for (const listener of listeners) listener();
    }
    for (const listener of this.all) listener(tables, change);
  }
}
