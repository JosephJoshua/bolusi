// Clock-skew flagging (05 §6) — the formula, its boundary, and the structural fact that NO
// rejection is reachable from a timestamp.
import { describe, expect, test } from 'vitest';

import { isClockSkewed, SKEW_BASE_MS } from './skew.js';

const RECEIVED_AT = 1_726_900_000_000;
const HOUR = 60 * 60 * 1000;

describe('the 48h + offline-window threshold', () => {
  test('SKEW_BASE_MS is the documented 48 hours', () => {
    expect(SKEW_BASE_MS).toBe(48 * HOUR);
  });

  test('an op inside the window is not flagged', () => {
    expect(isClockSkewed(RECEIVED_AT - HOUR, RECEIVED_AT, RECEIVED_AT - 60_000)).toBe(false);
  });

  test('an op EXACTLY at the boundary is not flagged (strict >)', () => {
    // lastSyncAt == receivedAt ⇒ offline window 0 ⇒ threshold is exactly 48h.
    expect(isClockSkewed(RECEIVED_AT - SKEW_BASE_MS, RECEIVED_AT, RECEIVED_AT)).toBe(false);
  });

  test('one millisecond past the boundary IS flagged', () => {
    expect(isClockSkewed(RECEIVED_AT - SKEW_BASE_MS - 1, RECEIVED_AT, RECEIVED_AT)).toBe(true);
  });

  test('the window GROWS with the device offline gap (CHAOS-04 device C)', () => {
    // Offline 5 days with a +72h-skewed clock: threshold = 48h + 120h = 168h — within allowance,
    // so a days-offline store's honest backlog is NOT flagged as tamper.
    const lastSyncAt = RECEIVED_AT - 120 * HOUR;
    expect(isClockSkewed(RECEIVED_AT - 72 * HOUR, RECEIVED_AT, lastSyncAt)).toBe(false);
  });

  test('a skew beyond the grown window is still flagged', () => {
    const lastSyncAt = RECEIVED_AT - 120 * HOUR;
    expect(isClockSkewed(RECEIVED_AT - 200 * HOUR, RECEIVED_AT, lastSyncAt)).toBe(true);
  });

  test('skew is symmetric — a clock in the FUTURE flags too (CHAOS-04 device A)', () => {
    expect(isClockSkewed(RECEIVED_AT + 72 * HOUR, RECEIVED_AT, RECEIVED_AT - 60_000)).toBe(true);
  });

  test('a never-synced device gets the bare 48h window (no offline credit)', () => {
    expect(isClockSkewed(RECEIVED_AT - 49 * HOUR, RECEIVED_AT, null)).toBe(true);
    expect(isClockSkewed(RECEIVED_AT - 47 * HOUR, RECEIVED_AT, null)).toBe(false);
  });

  test('a lastSyncAt in the future never shrinks the window below 48h', () => {
    // max(0, …) guard: a device whose last_sync_at is ahead of receivedAt must not get a NEGATIVE
    // offline window, which would tighten the threshold and flag honest ops.
    expect(isClockSkewed(RECEIVED_AT - 47 * HOUR, RECEIVED_AT, RECEIVED_AT + 10 * HOUR)).toBe(
      false,
    );
  });
});

describe('flag, never reject (05 §6)', () => {
  test('the skew step returns only a boolean — no rejection code is reachable from it', () => {
    // Structural: `isClockSkewed` is the ONLY timestamp-driven branch in the pipeline and its type
    // is boolean. There is no code path from a timestamp to a rejection — the server assumes
    // drift, not malice, and the op's timestamp stays business truth through late sync.
    const outcomes = new Set(
      [
        isClockSkewed(RECEIVED_AT, RECEIVED_AT, null),
        isClockSkewed(0, RECEIVED_AT, null),
        isClockSkewed(RECEIVED_AT * 2, RECEIVED_AT, null),
        isClockSkewed(-1, RECEIVED_AT, RECEIVED_AT),
      ].map((v) => typeof v),
    );
    expect([...outcomes]).toEqual(['boolean']);
  });

  test('even an absurd timestamp yields a flag rather than a throw', () => {
    expect(() => isClockSkewed(Number.MAX_SAFE_INTEGER, RECEIVED_AT, null)).not.toThrow();
    expect(isClockSkewed(Number.MAX_SAFE_INTEGER, RECEIVED_AT, null)).toBe(true);
  });
});
