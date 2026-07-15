import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  STALENESS_STALE_MS,
  STALENESS_WARNING_MS,
  serverRelativeAgeMs,
  stalenessLevel,
  type SyncState,
} from './contract.js';

// A string path, not `new URL(…)`: under Expo's tsconfig base the global `URL` is DOM's, which
// node's `fileURLToPath` does not accept. See vitest.config.ts for the same note.
const SPEC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ai-docs/03-state-machines.md'),
  'utf8',
);

/** A `SyncState` with a coherent server baseline, overridable per case. */
function syncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    lastSuccessfulSyncAt: 1_000_000,
    pushHalted: false,
    syncDisabled: false,
    syncDisabledReason: null,
    loopState: 'idle',
    lastServerTime: 1_000_000,
    lastServerTimeAt: 1_000_000,
    ...overrides,
  };
}

describe('the staleness thresholds are the spec`s, not this file`s', () => {
  // T-13 (interrogate the oracle): 03 §8 declares itself "the sole numeric source for staleness
  // thresholds". A test that restated 3_600_000 here would assert only that this file agrees with
  // ITSELF — it would stay green after the doc moved, which is the failure mode that matters,
  // because these constants are a STOPGAP transcription and drift is their whole risk.
  //
  // So the numbers are parsed out of the doc. When task 15 exports the real constants from
  // @bolusi/core, this test should point at THOSE and this file should be deleted.
  const parse = (name: string): number => {
    const match = SPEC.match(new RegExp(`\`${name} = ([0-9_]+)\``));
    // The parse's own denominator (T-14): a doc reformat that stopped matching would otherwise
    // make `undefined === undefined` pass and silently check nothing.
    expect(match, `03 §8 no longer declares ${name} in the expected form`).not.toBeNull();
    return Number(match![1]!.replaceAll('_', ''));
  };

  test('STALENESS_WARNING_MS equals 03 §8`s declared constant', () => {
    expect(STALENESS_WARNING_MS).toBe(parse('STALENESS_WARNING_MS'));
  });

  test('STALENESS_STALE_MS equals 03 §8`s declared constant', () => {
    expect(STALENESS_STALE_MS).toBe(parse('STALENESS_STALE_MS'));
  });
});

describe('stalenessLevel — 03 §8 tiers, boundaries computed from the constants', () => {
  // No numeric literals: every boundary is expressed against the exported constants, so a threshold
  // change moves these cases with it rather than falsifying them.
  const base = 1_000_000;

  test('fresh below the warning threshold, on both sides of the boundary', () => {
    const state = syncState({ lastSuccessfulSyncAt: base });
    expect(stalenessLevel(state, base)).toBe('fresh');
    expect(stalenessLevel(state, base + STALENESS_WARNING_MS - 1)).toBe('fresh');
  });

  test('warning AT the threshold — 03 §8 is `1 h ≤ age`, inclusive', () => {
    const state = syncState({ lastSuccessfulSyncAt: base });
    expect(stalenessLevel(state, base + STALENESS_WARNING_MS)).toBe('warning');
    expect(stalenessLevel(state, base + STALENESS_STALE_MS - 1)).toBe('warning');
  });

  test('stale AT the threshold — 03 §8 is `age ≥ 24 h`, inclusive', () => {
    const state = syncState({ lastSuccessfulSyncAt: base });
    expect(stalenessLevel(state, base + STALENESS_STALE_MS)).toBe('stale');
  });

  test('never synced is stale, not fresh — the case that matters most (03 §8)', () => {
    // A device that has never synced knows nothing. Reading `null` as "age 0 ⇒ fresh" would show an
    // empty screen as though it were the truth; 03 §8's condition column says `stale` outright.
    expect(stalenessLevel(syncState({ lastSuccessfulSyncAt: null }), base)).toBe('stale');
    expect(serverRelativeAgeMs(syncState({ lastSuccessfulSyncAt: null }), base)).toBeNull();
  });
});

describe('a drifted device clock cannot fake freshness (03 §8, api/01-sync §7)', () => {
  test('age is measured from the captured serverTime, not the device wall clock', () => {
    // The device clock is 10 days FAST relative to the server. Naive `now - lastSuccessfulSyncAt`
    // would read ~10 days and scream `stale`; the server-relative baseline reads the true elapsed.
    const deviceSkew = STALENESS_STALE_MS * 10;
    const state = syncState({
      lastSuccessfulSyncAt: base(),
      lastServerTime: base(),
      lastServerTimeAt: base() + deviceSkew,
    });
    expect(stalenessLevel(state, base() + deviceSkew)).toBe('fresh');
    expect(serverRelativeAgeMs(state, base() + deviceSkew)).toBe(0);
  });

  test('winding the clock BACKWARDS cannot make stale data read as fresh', () => {
    // The dangerous direction: a negative elapsed would subtract from the server baseline and pull
    // the computed age below the threshold. Elapsed is floored at 0, so the age can only stand
    // still — it never shrinks. Same reasoning as SEC-AUTH-04's `notBefore`.
    const state = syncState({
      lastSuccessfulSyncAt: base() - STALENESS_STALE_MS * 2,
      lastServerTime: base(),
      lastServerTimeAt: base(),
    });
    expect(stalenessLevel(state, base())).toBe('stale');
    // Roll the device clock back a year: still stale, never fresh.
    expect(stalenessLevel(state, base() - STALENESS_STALE_MS * 365)).toBe('stale');
    expect(serverRelativeAgeMs(state, base() - STALENESS_STALE_MS * 365)).toBeGreaterThanOrEqual(
      STALENESS_STALE_MS,
    );
  });

  function base(): number {
    return 10_000_000_000;
  }
});
