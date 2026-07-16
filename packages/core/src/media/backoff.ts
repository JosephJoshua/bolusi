// Media per-item retry backoff — schedule OWNED BY 03-state-machines §4.1: 5 s → 15 s → 60 s →
// 5 min cap, indexed by `uploadAttempts`. 06-media-pipeline §5.3 deliberately cross-references
// these numbers without restating them, and so does this file's caller.
//
// WHY THIS IS NOT `syncBackoffDelayMs`. sync/backoff.ts pre-empts the §2.8 objection by name:
// "Sharing the shape with 03 §4.1's media schedule would be a false reuse — same numbers today,
// different owners and different change control, so they stay separate." Two schedules that agree
// by coincidence are not one schedule: api/01-sync §6 may retune the sync curve without touching
// 03 §4.1, and a shared constant would silently drag media along. Same const-data + throwing-
// accessor SHAPE, separate ownership. A reviewer citing §2.8 here has the citation above.

/** The delays, in order, last entry being the cap (03 §4.1). */
export const MEDIA_BACKOFF_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000] as const;

/**
 * 03 §4.1's persistent-failure surfacing threshold. Crossing it escalates VISIBILITY only —
 * "retries continue at the 5-min cap forever — surfacing escalates visibility, never stops
 * retrying" (03 §4.1; 06 §8).
 */
export const MEDIA_PERSISTENT_FAILURE_ATTEMPTS = 5;

/**
 * Delay before retrying an item that has failed `uploadAttempts` times (1-based: the first
 * failure waits `MEDIA_BACKOFF_SCHEDULE_MS[0]` = 5 s). Clamped to the 5-min cap forever after.
 *
 * @throws {RangeError} on `uploadAttempts < 1` — asking for the delay after zero failures is a
 * caller bug, and returning 0 (or the first delay) would hide it behind a plausible number.
 */
export function mediaBackoffDelayMs(uploadAttempts: number): number {
  if (!Number.isInteger(uploadAttempts) || uploadAttempts < 1) {
    throw new RangeError(`uploadAttempts must be an integer >= 1, got ${uploadAttempts}`);
  }
  const index = Math.min(uploadAttempts, MEDIA_BACKOFF_SCHEDULE_MS.length) - 1;
  return MEDIA_BACKOFF_SCHEDULE_MS[index] as number;
}

/**
 * 03 §4.1 / 06 §8: `uploadAttempts >= 5` ⇒ the persistent-failure indicator is shown. This is the
 * COUNTER arm of 06 §8's definition; the "still not uploaded 24 h after capture while the device
 * has synced ops" arm is time-based and lives in surfacing.ts, because it needs a clock and the
 * op-sync fact.
 */
export function isPersistentlyFailing(uploadAttempts: number): boolean {
  return uploadAttempts >= MEDIA_PERSISTENT_FAILURE_ATTEMPTS;
}
