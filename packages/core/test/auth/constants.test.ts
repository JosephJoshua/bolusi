// CHAOS-11 precursors (testing-guide §3.6) + the SEC-AUTH-01 KDF-parameter numbers.
//
// CHAOS-11 (task 26) imports these constants rather than duplicating the numbers as literals, so
// this suite pins the EXACT values (T-14: assert the actual numbers). If a value drifts, CHAOS-11
// would silently test the wrong schedule — these assertions are what stop that.
import { describe, expect, it } from 'vitest';

import {
  clampIdleLockSeconds,
  DEFAULT_KDF_PARAMS,
  delayMsForFailureCount,
  FLOOR_KDF_PARAMS,
  IDLE_LOCK_DEFAULT_SECONDS,
  IDLE_LOCK_MAX_SECONDS,
  IDLE_LOCK_MIN_SECONDS,
  PIN_FREE_ATTEMPTS,
  PIN_HARD_LOCK_THRESHOLD,
  PIN_KDF_BOUNDS,
  PIN_LOCKOUT_DELAY_CAP_MS,
  PIN_LOCKOUT_SCHEDULE,
} from '../../src/index.js';

describe('CHAOS-11 precursors — exported lockout constants (api/02-auth §6.5)', () => {
  it('free-attempt count is 3 and the hard-lock threshold is 10', () => {
    expect(PIN_FREE_ATTEMPTS).toBe(3);
    expect(PIN_HARD_LOCK_THRESHOLD).toBe(10);
  });

  it('the delay steps are exactly 30 / 60 / 120 / 300 s (300 s cap)', () => {
    expect(PIN_LOCKOUT_SCHEDULE.map((s) => s.delayMs)).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(PIN_LOCKOUT_SCHEDULE.map((s) => s.consecutiveFailures)).toEqual([3, 4, 5, 6]);
    expect(PIN_LOCKOUT_DELAY_CAP_MS).toBe(300_000);
  });

  it('delayMsForFailureCount maps every count to its api/02-auth §6.5 window', () => {
    // Free band: no delay.
    expect(delayMsForFailureCount(0)).toBe(0);
    expect(delayMsForFailureCount(1)).toBe(0);
    expect(delayMsForFailureCount(2)).toBe(0);
    // Escalation.
    expect(delayMsForFailureCount(3)).toBe(30_000);
    expect(delayMsForFailureCount(4)).toBe(60_000);
    expect(delayMsForFailureCount(5)).toBe(120_000);
    // Cap covers 6..9.
    expect(delayMsForFailureCount(6)).toBe(300_000);
    expect(delayMsForFailureCount(7)).toBe(300_000);
    expect(delayMsForFailureCount(8)).toBe(300_000);
    expect(delayMsForFailureCount(9)).toBe(300_000);
    expect(delayMsForFailureCount(10)).toBe(300_000);
  });
});

describe('SEC-AUTH-01 — KDF parameter constants (api/02-auth §5.3)', () => {
  it('the DEFAULT profile is m=32768 / t=3 / p=1 / 32-byte output', () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({
      memoryCost: 32768,
      timeCost: 3,
      parallelism: 1,
      outputLength: 32,
    });
  });

  it('the documented FLOOR is m=19456 / t=2 / p=1 / 32-byte output (D8)', () => {
    expect(FLOOR_KDF_PARAMS).toEqual({
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLength: 32,
    });
  });

  it('the accepted bounds are mKiB∈[19456,65536], t∈[2,4], p=1, salt 16 B, hash 32 B', () => {
    expect(PIN_KDF_BOUNDS.memoryCostMin).toBe(19456);
    expect(PIN_KDF_BOUNDS.memoryCostMax).toBe(65536);
    expect(PIN_KDF_BOUNDS.timeCostMin).toBe(2);
    expect(PIN_KDF_BOUNDS.timeCostMax).toBe(4);
    expect(PIN_KDF_BOUNDS.parallelism).toBe(1);
    expect(PIN_KDF_BOUNDS.saltBytes).toBe(16);
    expect(PIN_KDF_BOUNDS.hashBytes).toBe(32);
    // The floor is exactly the lower memory bound — the "floor is reachable" property (D12).
    expect(FLOOR_KDF_PARAMS.memoryCost).toBe(PIN_KDF_BOUNDS.memoryCostMin);
  });
});

describe('idle-lock clamp (api/02-auth §6.4)', () => {
  it('defaults, clamps to [60, 3600], and truncates', () => {
    expect(IDLE_LOCK_DEFAULT_SECONDS).toBe(300);
    expect(IDLE_LOCK_MIN_SECONDS).toBe(60);
    expect(IDLE_LOCK_MAX_SECONDS).toBe(3600);
    expect(clampIdleLockSeconds(300)).toBe(300);
    expect(clampIdleLockSeconds(10)).toBe(60);
    expect(clampIdleLockSeconds(99999)).toBe(3600);
    expect(clampIdleLockSeconds(120.9)).toBe(120);
    expect(clampIdleLockSeconds(Number.NaN)).toBe(300);
  });
});
