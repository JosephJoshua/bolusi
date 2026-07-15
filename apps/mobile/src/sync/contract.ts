/**
 * LOCAL STOPGAP — **DELETE in favour of `@bolusi/core`'s sync-client surface when task 15 lands.**
 * Flagged for task 33 (stopgap reconciliation). Do not grow this file; do not import it from
 * anywhere but `apps/mobile`.
 *
 * WHY IT EXISTS. This task's Sync Status screen consumes `SyncState` (01-domain-model §5.2) and the
 * staleness tiers (03-state-machines §8). 03 §8 says outright: "Constants in `@bolusi/core`:
 * `STALENESS_WARNING_MS = 3_600_000`, `STALENESS_STALE_MS = 86_400_000`" — but task 15 (sync-client)
 * is NOT merged, `@bolusi/core` exports neither the constants nor the type, and `@bolusi/core` is
 * CONTENDED this wave (task 46 is live in it), so adding them there is not this task's to do.
 *
 * WHAT IS AND IS NOT DECIDED HERE. Nothing. Every value below is transcribed from the owning spec,
 * which stays the sole source: 03 §8 owns the thresholds ("**This section is the sole numeric source
 * for staleness thresholds**"), 01 §5.2 owns the field list, 03 §10 owns the loop's guards. When
 * task 15 exports these, this file is deleted and the imports repoint — the shapes are written to
 * match so that deletion is a repoint, not a rewrite.
 *
 * THE ONE THING A REVIEWER SHOULD CHECK: that these constants still equal 03 §8's. `staleness.test.ts`
 * parses the numbers out of the spec table itself rather than restating them, so a threshold change
 * in the doc fails this lane instead of silently disagreeing with it (T-13 — interrogate the oracle).
 */

/** 03 §8: `warning` at `age ≥ 1 h`. Transcribed from the spec; never redefined here. */
export const STALENESS_WARNING_MS = 3_600_000;

/** 03 §8: `stale` at `age ≥ 24 h`, or never synced. Transcribed from the spec. */
export const STALENESS_STALE_MS = 86_400_000;

/** 03 §8's derived level. Never a persisted column — recomputed on demand. */
export type StalenessLevel = 'fresh' | 'warning' | 'stale';

/** 03 §10: why automatic sync is off. `null` ⇒ sync is enabled. */
export type SyncDisabledReason = 'device_revoked';

/** 03 §10's loop states. In-memory, one instance per app process, single-flight. */
export type SyncLoopState = 'idle' | 'pushing' | 'pulling' | 'backoff';

/**
 * `SyncState` (01-domain-model §5.2; guards per 03 §10).
 *
 * `pendingOperationCount` / `pendingMediaCount` are **deliberately absent**: 01 §5.2 states they are
 * derived queries and NEVER stored, so putting them on this record would be the exact bug the spec
 * names. The screen reads them through `DerivedCounts` below, and its test proves no stored count is
 * read (a field that does not exist cannot be read — the type is the guard).
 */
export interface SyncState {
  /** ms epoch of the last completed pull drain (03 §8/§10), or null when never synced. */
  readonly lastSuccessfulSyncAt: number | null;
  /** 03 §10: set by `CHAIN_BROKEN`. Push is skipped; pull continues. */
  readonly pushHalted: boolean;
  /** 03 §10: set by `401 DEVICE_REVOKED`. No further automatic cycles until re-enrollment. */
  readonly syncDisabled: boolean;
  readonly syncDisabledReason: SyncDisabledReason | null;
  /** The loop's current state (03 §10). */
  readonly loopState: SyncLoopState;
  /**
   * `serverTime` captured at the last successful pull (api/01-sync §7). The staleness baseline —
   * see `stalenessLevel` for why the raw device clock is not trusted alone.
   */
  readonly lastServerTime: number | null;
  /** Device `now` at the moment `lastServerTime` was captured — the elapsed-time anchor. */
  readonly lastServerTimeAt: number | null;
}

/**
 * The derived counters (01 §5.2 — recomputed on demand, never stored). Passed as a separate object
 * from `SyncState` precisely so the "never stored" rule is visible in the type system rather than
 * asserted in prose.
 */
export interface DerivedCounts {
  readonly pendingOperationCount: number;
  readonly pendingMediaCount: number;
}

/**
 * Server-relative age in ms (api/01-sync §7; 03 §8).
 *
 * A DRIFTED CLOCK MUST NOT FAKE FRESHNESS — 03 §8 says so explicitly, and it is the reason this is a
 * function rather than `now - lastSuccessfulSyncAt`. The baseline is the `serverTime` captured at
 * the last successful pull PLUS elapsed device time since; only the *elapsed* part comes from the
 * device clock, so a device whose clock is wound forward or back cannot move the last-sync point.
 *
 * Elapsed time is floored at 0: a backwards clock jump would otherwise compute a NEGATIVE elapsed
 * and make stale data read as fresh — the one direction that must never happen (SEC-AUTH-04 applies
 * the same reasoning to the lockout window).
 */
export function serverRelativeAgeMs(state: SyncState, now: number): number | null {
  if (state.lastSuccessfulSyncAt === null) return null;
  if (state.lastServerTime === null || state.lastServerTimeAt === null) {
    // No server baseline yet: fall back to the device clock, still floored at 0.
    return Math.max(0, now - state.lastSuccessfulSyncAt);
  }
  const elapsedSinceBaseline = Math.max(0, now - state.lastServerTimeAt);
  const serverNow = state.lastServerTime + elapsedSinceBaseline;
  return Math.max(0, serverNow - state.lastSuccessfulSyncAt);
}

/**
 * 03 §8's level. `null` age (never synced) is `stale` — "**or never synced**" is in the spec's own
 * condition column, and it is the case that matters most: a device that has never synced knows
 * nothing, and must say so loudly rather than quietly showing an empty screen as if it were the truth.
 */
export function stalenessLevel(state: SyncState, now: number): StalenessLevel {
  const age = serverRelativeAgeMs(state, now);
  if (age === null) return 'stale';
  if (age >= STALENESS_STALE_MS) return 'stale';
  if (age >= STALENESS_WARNING_MS) return 'warning';
  return 'fresh';
}
