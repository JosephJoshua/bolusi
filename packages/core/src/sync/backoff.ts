// Sync-loop backoff schedule (api/01-sync §6, restated 03-state-machines §10): 5 s → 15 s → 60 s
// → 5 min cap, reset on success.
//
// Encoded ONCE as const data, indexed by `failureCount` (the in-memory counter of 03 §10), and
// exported so tests and the harness assert against the schedule rather than re-typing the numbers
// (CHAOS-11 makes the same rule explicit for the PIN schedule: "this scenario must not duplicate
// the numbers as literals"). Sharing the shape with 03 §4.1's media schedule would be a false
// reuse — same numbers today, different owners and different change control, so they stay separate.

/** The delays, in order, last entry being the cap (api/01-sync §6). */
export const SYNC_BACKOFF_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000] as const;

/**
 * Delay before retry after `failureCount` consecutive failures (1-based: the first failure waits
 * `SYNC_BACKOFF_SCHEDULE_MS[0]`). Clamped to the cap forever after — backoff escalates visibility,
 * never stops retrying.
 *
 * @throws {RangeError} on `failureCount < 1` — a caller asking for the delay after zero failures
 * has a bug, and returning 0 (or the first delay) would hide it.
 */
export function syncBackoffDelayMs(failureCount: number): number {
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new RangeError(`failureCount must be an integer >= 1, got ${failureCount}`);
  }
  const index = Math.min(failureCount, SYNC_BACKOFF_SCHEDULE_MS.length) - 1;
  return SYNC_BACKOFF_SCHEDULE_MS[index] as number;
}
