// The evaluator + its memo (02-permissions §6): a per-`(userId, storeId)` effective-set snapshot,
// invalidated by EVENTS ONLY — never by a TTL.
//
// WHY NO TTL, EVER. A time-based cache is stale authorization with a comforting name. "Expires in
// 60s" means "a revoked user keeps their access for up to 60s, and nobody can say which 60s". The
// two events that can change an effective set are both already observable — a bundle refresh
// writes the directory tables, and the active user switches — so a timer would buy nothing except
// a window. §6 forbids it; this module contains no clock, no timer, and no expiry field, and the
// suite asserts that advancing a FakeClock alone changes no answer.
//
// WHY THE MEMO IS ASYNC TO FILL AND SYNC TO READ. `hasPermission` must be synchronous (§6) so that
// every command and every query can afford it (NFR-1002) — but the rows live in SQLite behind
// async Kysely. So loading is an async event handler, and reading is a pure synchronous function
// over what was loaded. Between events the snapshot is deliberately frozen: a direct write to
// `users_directory` that did not come through a bundle refresh is NOT observed, and that is the
// specified behavior, not a bug.
//
// A device that is offline evaluates against its last-fetched bundle. That is correct (§6), and it
// has the documented consequence that revocations are EVENTUALLY effective — physical repossession
// is the urgent-revocation control, not software.
import {
  evaluatePermission,
  computeEffectiveSet,
  type EffectiveSet,
  type PermissionQuery,
  type PermissionResult,
} from './evaluate.js';
import {
  emptyDirectorySnapshot,
  type DirectorySnapshot,
  type DirectorySource,
} from './directory.js';
import type { PermissionRegistry } from './registry.js';

/** Memo key. A NUL separator cannot occur in a UUIDv7, so no `(userId, storeId)` pair can collide. */
function memoKey(userId: string, storeId: string | null): string {
  return `${userId}\u0000${storeId ?? ''}\u0000${storeId === null ? 'tenant' : 'store'}`;
}

/** Counters the suite reads to prove the memo memoizes and the events invalidate (T-14b). */
export interface PermissionEvaluatorStats {
  /** Directory loads performed — one per invalidation event, plus the initial prime. */
  readonly loads: number;
  /** Effective sets computed — one per `(userId, storeId)` per snapshot generation. */
  readonly computes: number;
  /** Snapshot generation: increments on every load. */
  readonly generation: number;
}

/**
 * The permission evaluator: registry + directory snapshot + memo, exposing the synchronous
 * `hasPermission` the single enforcement point calls (§4).
 *
 * Lifecycle:
 *   `await prime()`          — bootstrap, AFTER the enrollment bundle is written (§6 bootstrap rule)
 *   `hasPermission(q)`       — synchronous, on every command and query
 *   `await onBundleRefresh()`— §6 (a): a bundle refresh wrote a directory table
 *   `await onUserSwitch()`   — §6 (b): the active user switched
 */
export class PermissionEvaluator {
  private readonly registry: PermissionRegistry;
  private readonly source: DirectorySource;
  private snapshot: DirectorySnapshot = emptyDirectorySnapshot();
  private primed = false;
  private effective = new Map<string, EffectiveSet>();
  private loads = 0;
  private computes = 0;
  private generation = 0;

  constructor(registry: PermissionRegistry, source: DirectorySource) {
    this.registry = registry;
    this.source = source;
  }

  /**
   * Load the directory into memory. Call once at bootstrap, after the enrollment bundle is written
   * into the mirrors and BEFORE the first command executes (§6 bootstrap rule).
   */
  async prime(): Promise<void> {
    await this.reload();
  }

  /** True once a directory load has succeeded. Until then every evaluation denies (see below). */
  get isPrimed(): boolean {
    return this.primed;
  }

  get stats(): PermissionEvaluatorStats {
    return { loads: this.loads, computes: this.computes, generation: this.generation };
  }

  /**
   * §6 invalidation (a): a bundle refresh wrote a directory table. Drops the snapshot and the memo
   * and recomputes from the mirrors. §8.5: grow and shrink take the same path — there is no
   * "grant fast, revoke slow" asymmetry.
   */
  async onBundleRefresh(): Promise<void> {
    await this.reload();
  }

  /**
   * §6 invalidation (b): the active user switched. Drops the snapshot and the memo.
   *
   * It reloads rather than merely clearing the derived memo because §6 says the snapshot is
   * dropped on this event, full stop — and the cheaper alternative ("the directory can't have
   * changed, so keep it") is an assumption about someone else's write path that authorization
   * should not be making.
   */
  async onUserSwitch(): Promise<void> {
    await this.reload();
  }

  /**
   * `hasPermission` (§5.2) — synchronous, allocation-light, no I/O.
   *
   * Before the first successful load there is no directory to evaluate against, so every call
   * denies `evaluation_error`: an evaluator that cannot see its own inputs must not answer
   * "allowed", and the bootstrap rule (§6) means this state should be unreachable in a correct
   * runtime. Fail closed covers the case where it is not.
   */
  hasPermission(query: PermissionQuery): PermissionResult {
    if (!this.primed) return { allowed: false, reason: 'evaluation_error' };
    return evaluatePermission(this.registry, this.snapshot, query, (userId, storeId) =>
      this.effectiveSetFor(userId, storeId),
    );
  }

  /**
   * The `(userId, storeId)` effective set (§5.2 steps 4–6), memoized for this snapshot generation.
   *
   * Public because the invalidation hooks (invalidation.ts, §8.4) diff a principal's effective set
   * across a refresh, and because a role editor needs to show what a user actually holds.
   */
  effectiveSetFor(userId: string, storeId: string | null): EffectiveSet {
    const key = memoKey(userId, storeId);
    const cached = this.effective.get(key);
    if (cached !== undefined) return cached;
    // May throw on a corrupt row — `evaluatePermission` catches it into `evaluation_error`. A
    // throw is deliberately NOT cached: the memo holds decisions, never failures.
    const computed = computeEffectiveSet(this.snapshot, userId, storeId);
    this.computes += 1;
    this.effective.set(key, computed);
    return computed;
  }

  /** The current snapshot — for the §8.4 hook wiring and for tests. */
  get directory(): DirectorySnapshot {
    return this.snapshot;
  }

  private async reload(): Promise<void> {
    // Load BEFORE swapping: a failed refresh must leave the previous (correct, if stale) snapshot
    // standing rather than blanking authorization to `evaluation_error` for everyone.
    const loaded = await this.source.load();
    this.snapshot = loaded;
    this.effective = new Map();
    this.loads += 1;
    this.generation += 1;
    this.primed = true;
  }
}
