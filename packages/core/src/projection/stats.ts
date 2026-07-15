// Public projection-engine counters (04-module-contract §4.2 dispatch observability).
//
// These are the signal CHAOS-01 (testing-guide §3.6) needs: an out-of-order convergence run
// must confirm it exercised BOTH §4.2 paths — head-apply (op canonically newest) and re-fold
// (op sorts before an already-applied op) — or it fails as INCONCLUSIVE. Without public
// counters a green run could have taken only one path and proved nothing (T-11).
//
// In-memory only: they measure a run, are not persisted, and reset on a fresh engine. Nothing
// correctness-bearing depends on them — the rebuild cursor and watermarks are the durable
// state; these are pure instrumentation.

/** A read-only snapshot of the counters. */
export interface ProjectionStatsSnapshot {
  /** Ops applied incrementally as the entity's canonical head (§4.2 head case). */
  readonly headApplies: number;
  /** Ops that sorted before an applied op ⇒ entity delete + full re-fold (§4.2). */
  readonly refolds: number;
  /** Ops skipped because no registered module owns their `type`. */
  readonly unregistered: number;
  /** Full rebuilds started (04 §4.3). */
  readonly rebuilds: number;
  /** Rebuild batches applied (checkpoints written) — resume progress. */
  readonly rebuildBatches: number;
  /** Ops applied during rebuilds (all head-case, canonical order). */
  readonly rebuildApplies: number;
}

export class ProjectionStats {
  private counters = {
    headApplies: 0,
    refolds: 0,
    unregistered: 0,
    rebuilds: 0,
    rebuildBatches: 0,
    rebuildApplies: 0,
  };

  recordHeadApply(): void {
    this.counters.headApplies += 1;
  }
  recordRefold(): void {
    this.counters.refolds += 1;
  }
  recordUnregistered(): void {
    this.counters.unregistered += 1;
  }
  recordRebuildStart(): void {
    this.counters.rebuilds += 1;
  }
  recordRebuildBatch(appliedInBatch: number): void {
    this.counters.rebuildBatches += 1;
    this.counters.rebuildApplies += appliedInBatch;
  }

  snapshot(): ProjectionStatsSnapshot {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = {
      headApplies: 0,
      refolds: 0,
      unregistered: 0,
      rebuilds: 0,
      rebuildBatches: 0,
      rebuildApplies: 0,
    };
  }
}
