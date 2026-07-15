// Staleness levels (03-state-machines §8). 03 §8 is the SOLE numeric source for the thresholds:
// api/01-sync §7 and the design system reference these constants without restating them, and the
// numbers change only by editing 03 §8 first. Tests import the constants rather than writing `3600000`
// — a test with the literal in it passes a threshold change it should have caught.
//
// SERVER-RELATIVE BY CONSTRUCTION (api/01-sync §7, 03 §8). `age` must not trust the device
// wall-clock alone: a drifted clock would otherwise fake freshness (drift forward ⇒ everything looks
// stale; drift back ⇒ a month-old cache looks fresh, which is the dangerous direction). The baseline
// is the `serverTime` captured at the last successful pull PLUS the local time elapsed since it was
// received. Both halves come from the same local clock, so the *difference* is a genuine elapsed
// interval even when that clock is wrong in absolute terms — only its RATE has to be sane, and a
// step change (user sets the date) cancels out of the subtraction entirely.

import type { ClockPort } from '../runtime/ports.js';

/** `fresh → warning` at 1 h (03 §8). */
export const STALENESS_WARNING_MS = 3_600_000;

/** `warning → stale` at 24 h (03 §8). */
export const STALENESS_STALE_MS = 86_400_000;

/** The three derived levels (03 §8). Not a persisted column — recomputed on demand. */
export type StalenessLevel = 'fresh' | 'warning' | 'stale';

/** The `SyncState` fields the level computation reads (01-domain-model §5.2). */
export interface StalenessInput {
  /** `null` = never synced ⇒ always `stale` (03 §8). */
  readonly lastSuccessfulSyncAt: number | null;
  /** `serverTime` from the last sync response, with the local instant it arrived. */
  readonly lastServerTime: number | null;
  readonly lastServerTimeReceivedAt: number | null;
}

/**
 * Server-relative age in ms, or `null` when never synced.
 *
 * `now` is the device clock, used ONLY inside differences against a value stamped by the same
 * clock (`lastServerTimeReceivedAt`), never as an absolute instant compared to a server value.
 * That is what makes the result drift-proof: `elapsed` is real time, and the server's own
 * `lastServerTime` anchors the absolute position.
 *
 * Falls back to the device clock only when no server time was ever captured — which cannot
 * co-occur with a non-null `lastSuccessfulSyncAt` in the loop (a successful drain always records
 * `serverTime`), so the fallback is defensive, not a supported path.
 */
export function stalenessAgeMs(input: StalenessInput, now: number): number | null {
  if (input.lastSuccessfulSyncAt === null) return null;
  if (input.lastServerTime === null || input.lastServerTimeReceivedAt === null) {
    return Math.max(0, now - input.lastSuccessfulSyncAt);
  }
  // Elapsed since the server spoke, measured entirely in local-clock deltas.
  const elapsed = now - input.lastServerTimeReceivedAt;
  const serverNow = input.lastServerTime + elapsed;
  return Math.max(0, serverNow - input.lastSuccessfulSyncAt);
}

/**
 * The staleness level (03 §8): `fresh` < 1 h ≤ `warning` < 24 h ≤ `stale`; never-synced ⇒ `stale`.
 *
 * Boundaries are inclusive-at-the-top per 03 §8's `1 h ≤ age < 24 h`: exactly 1 h is `warning`,
 * exactly 24 h is `stale`.
 */
export function stalenessLevel(input: StalenessInput, clock: ClockPort): StalenessLevel {
  const age = stalenessAgeMs(input, clock.now());
  if (age === null) return 'stale';
  if (age >= STALENESS_STALE_MS) return 'stale';
  if (age >= STALENESS_WARNING_MS) return 'warning';
  return 'fresh';
}
