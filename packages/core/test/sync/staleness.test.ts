// Staleness levels + thresholds (03-state-machines §8; consumer contract api/01-sync §7).
//
// NO NUMERIC LITERALS FOR THRESHOLDS. Every boundary below is expressed in terms of the EXPORTED
// constants. A test that wrote `3_600_000` would keep passing after someone changed the constant to
// 2 h — it would assert the old contract against the new code and call that agreement. 03 §8 is the
// sole numeric source; these tests consume it, they do not restate it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STALENESS_STALE_MS,
  STALENESS_WARNING_MS,
  stalenessAgeMs,
  stalenessLevel,
  type StalenessInput,
} from '../../src/index.js';
import { FakeClock } from './_fixtures.js';

const SERVER_T0 = 1_726_000_000_000;

/** A device in perfect agreement with the server: honest clock, just synced. */
function syncedAt(age: number, over: Partial<StalenessInput> = {}): StalenessInput {
  return {
    lastSuccessfulSyncAt: SERVER_T0 - age,
    lastServerTime: SERVER_T0,
    lastServerTimeReceivedAt: SERVER_T0,
    ...over,
  };
}

const at = (now: number) => new FakeClock(now);

describe('staleness thresholds (03 §8)', () => {
  // T-13, INTERROGATE THE ORACLE — and this block is here because the oracle was wrong.
  //
  // This test used to assert `STALENESS_WARNING_MS === 60 * 60 * 1000` under a comment claiming the
  // numbers were checked "against 03 §8's table". They were not: the right-hand side was a
  // hand-computed literal, so the assertion only proved this file agrees with ITSELF. Change 03 §8
  // to 2 h and the code would disagree with the spec while this test stayed green — the exact drift
  // it was written to catch, invisible to it. The comment was the guard (CLAUDE.md §2.11).
  //
  // So the numbers are PARSED out of the doc, which is the shape task 24's `sync/contract.test.ts`
  // used for the same constants while they were a local stopgap. That file is deleted by task 50
  // (the constants now live here, §2.8); its guard moves here rather than dying with it — it is the
  // only thing standing between 03 §8's "**sole numeric source**" claim and a silent divergence.
  const SPEC = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ai-docs/03-state-machines.md'),
    'utf8',
  );

  const fromSpec = (name: string): number => {
    const match = SPEC.match(new RegExp(`\`${name} = ([0-9_]+)\``));
    // The parse's OWN denominator (T-14): a doc reformat that stopped matching would otherwise let
    // `undefined === undefined` pass and check nothing — a guard whose failure mode is "silently
    // checks nothing" is worse than no guard.
    expect(match, `03 §8 no longer declares ${name} in the expected form`).not.toBeNull();
    return Number(match![1]!.replaceAll('_', ''));
  };

  it('STALENESS_WARNING_MS equals 03 §8`s declared constant', () => {
    expect(STALENESS_WARNING_MS).toBe(fromSpec('STALENESS_WARNING_MS'));
  });

  it('STALENESS_STALE_MS equals 03 §8`s declared constant', () => {
    expect(STALENESS_STALE_MS).toBe(fromSpec('STALENESS_STALE_MS'));
  });

  it('never synced ⇒ stale, whatever the clock says (03 §8)', () => {
    const never: StalenessInput = {
      lastSuccessfulSyncAt: null,
      lastServerTime: null,
      lastServerTimeReceivedAt: null,
    };
    expect(stalenessLevel(never, at(SERVER_T0))).toBe('stale');
    expect(stalenessAgeMs(never, SERVER_T0)).toBeNull();
  });

  it('fresh below the warning threshold', () => {
    expect(stalenessLevel(syncedAt(0), at(SERVER_T0))).toBe('fresh');
    expect(stalenessLevel(syncedAt(STALENESS_WARNING_MS - 1), at(SERVER_T0))).toBe('fresh');
  });

  it('EXACTLY at the warning threshold ⇒ warning (03 §8: `1 h ≤ age`)', () => {
    // The boundary is inclusive at the bottom. Off-by-one here is a real bug class: `>` vs `>=`
    // silently shifts every escalation by one millisecond-of-truth, and nobody would notice.
    expect(stalenessLevel(syncedAt(STALENESS_WARNING_MS), at(SERVER_T0))).toBe('warning');
  });

  it('warning up to, but not including, the stale threshold', () => {
    expect(stalenessLevel(syncedAt(STALENESS_STALE_MS - 1), at(SERVER_T0))).toBe('warning');
  });

  it('EXACTLY at the stale threshold ⇒ stale (03 §8: `age ≥ 24 h`)', () => {
    expect(stalenessLevel(syncedAt(STALENESS_STALE_MS), at(SERVER_T0))).toBe('stale');
  });

  it('levels move in BOTH directions — a sync makes a stale device fresh again (03 §8)', () => {
    // "Levels move in both directions; there are no invalid transitions" — staleness is derived,
    // not a machine. A one-way implementation (a latch) would pass every test above.
    const stale = syncedAt(STALENESS_STALE_MS);
    expect(stalenessLevel(stale, at(SERVER_T0))).toBe('stale');
    const afterSync = syncedAt(0);
    expect(stalenessLevel(afterSync, at(SERVER_T0))).toBe('fresh');
    // and back down through warning
    expect(stalenessLevel(syncedAt(STALENESS_WARNING_MS), at(SERVER_T0))).toBe('warning');
  });
});

describe('staleness is server-relative — device clock drift must not change the level (api/01 §7)', () => {
  // The threat 03 §8 names: "a drifted clock must not fake freshness". The baseline is the server's
  // `serverTime` plus LOCAL elapsed, so a clock that is wrong in absolute terms cancels out of the
  // subtraction. These tests hold the true elapsed time fixed and move only the device's clock.
  const trueAge = STALENESS_WARNING_MS + 60_000; // genuinely `warning`

  /** Sync happened `trueAge` ago in real time; the device clock reads `skew` ms off. */
  function drifted(skew: number): { input: StalenessInput; now: number } {
    const receivedAt = SERVER_T0 - trueAge + skew; // stamped by the drifted local clock
    return {
      input: {
        lastSuccessfulSyncAt: SERVER_T0 - trueAge,
        lastServerTime: SERVER_T0 - trueAge, // what the server said at that moment
        lastServerTimeReceivedAt: receivedAt,
      },
      now: SERVER_T0 + skew, // the drifted clock, `trueAge` later
    };
  }

  it('a clock skewed 72 h FORWARD does not change the level', () => {
    const { input, now } = drifted(72 * 60 * 60 * 1000);
    expect(stalenessLevel(input, at(now))).toBe('warning');
    expect(stalenessAgeMs(input, now)).toBe(trueAge);
  });

  it('a clock skewed 72 h BACK does not fake freshness — the dangerous direction', () => {
    // The asymmetry matters: drifting forward makes a device look stale (a false alarm, cheap);
    // drifting BACK would make a month-old cache look current (a false assurance, expensive). This
    // is the case 03 §8 is actually defending against.
    const { input, now } = drifted(-72 * 60 * 60 * 1000);
    expect(stalenessLevel(input, at(now))).toBe('warning');
    expect(stalenessAgeMs(input, now)).toBe(trueAge);
  });

  it('a device clock that jumps between sync and read cannot manufacture freshness', () => {
    // Sync 25 h ago (genuinely `stale`); the user then sets the clock back a day to "fix" it.
    const realAge = STALENESS_STALE_MS + 3_600_000;
    const input: StalenessInput = {
      lastSuccessfulSyncAt: SERVER_T0 - realAge,
      lastServerTime: SERVER_T0 - realAge,
      lastServerTimeReceivedAt: SERVER_T0 - realAge,
    };
    // Naive `now - lastSuccessfulSyncAt` with a rolled-back clock would read as fresh. The
    // server-relative baseline holds: elapsed is measured against the RECEIPT stamp, and both moved.
    const rolledBack = SERVER_T0 - 24 * 60 * 60 * 1000;
    expect(stalenessAgeMs(input, rolledBack)).toBeGreaterThanOrEqual(0);
    expect(stalenessLevel(input, at(SERVER_T0))).toBe('stale');
  });

  it('age never goes negative, even with an absurd clock', () => {
    // A negative age would sort as "fresher than now" and could underflow a UI duration format.
    const input = syncedAt(0);
    expect(stalenessAgeMs(input, SERVER_T0 - 10_000_000)).toBe(0);
  });
});
