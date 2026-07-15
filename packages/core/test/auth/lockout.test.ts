// The PinAuth lockout machine, pure level (api/02-auth §6.5; 03-state-machines §9.2 code-table
// parity). The FakeClock-exact schedule, the KDF-not-run property, restart persistence and clock
// rollback are asserted end-to-end in pin-verify.test.ts against a real DB; here the machine's
// transition algebra is pinned directly, table-driven.
import { describe, expect, it } from 'vitest';

import {
  assertAttemptAllowed,
  clearedRow,
  clearLockout,
  derivePinAuthState,
  DomainError,
  PIN_HARD_LOCK_THRESHOLD,
  recordFailure,
  recordSuccess,
  resetForNewVerifier,
  type PinAttemptRow,
} from '../../src/index.js';

const U = 'user-1';
const D = 'device-1';

function expectDomain(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError && e.code === code) return e;
    throw new Error(`expected DomainError(${code}), got ${String(e)}`);
  }
  throw new Error(`expected DomainError(${code}), nothing thrown`);
}

function row(consecutiveFailures: number, notBefore: number | null): PinAttemptRow {
  return {
    userId: U,
    deviceId: D,
    consecutiveFailures,
    windowStartedAt: notBefore === null ? null : 0,
    notBefore,
  };
}

describe('SEC-AUTH-02/03 — derived states parity (03-state-machines §9.2)', () => {
  it('locked_out ⇔ ≥10, delayed ⇔ 3..9, else unlocked (derived from the row, not stored)', () => {
    expect(derivePinAuthState(null)).toBe('unlocked');
    for (const c of [0, 1, 2])
      expect(derivePinAuthState(row(c, null)), `count ${c}`).toBe('unlocked');
    for (const c of [3, 4, 5, 6, 7, 8, 9])
      expect(derivePinAuthState(row(c, 0)), `count ${c}`).toBe('delayed');
    for (const c of [10, 11])
      expect(derivePinAuthState(row(c, 0)), `count ${c}`).toBe('locked_out');
    expect(PIN_HARD_LOCK_THRESHOLD).toBe(10);
  });
});

describe('SEC-AUTH-02 — recordFailure opens each window at the exact schedule', () => {
  it('the 1st..10th consecutive failure follow 0/0/30/60/120/300/300/300/300/lock', () => {
    let current: PinAttemptRow | null = null;
    const nows = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const expectedDelays = [
      null,
      null,
      30_000,
      60_000,
      120_000,
      300_000,
      300_000,
      300_000,
      300_000,
      300_000,
    ];
    for (let i = 0; i < nows.length; i += 1) {
      const now = nows[i]!;
      const { row: next, lockedOut } = recordFailure(current, U, D, now);
      expect(next.consecutiveFailures, `after failure ${i + 1}`).toBe(i + 1);
      const delay = expectedDelays[i]!;
      expect(next.notBefore, `notBefore after failure ${i + 1}`).toBe(
        delay === null ? null : now + delay,
      );
      expect(lockedOut, `lockedOut after failure ${i + 1}`).toBe(i + 1 >= 10);
      // The window is opened at the FIRST failure and never moved earlier.
      expect(next.windowStartedAt).toBe(nows[0]);
      current = next;
    }
    expect(derivePinAuthState(current)).toBe('locked_out');
  });
});

describe('SEC-AUTH-02/04 — the gate refuses before the KDF, and a rollback cannot shrink a window', () => {
  it('delayed: attempt at delay−1ms throws PIN_RATE_LIMITED{retryAt}; at delay it is allowed', () => {
    const r = row(3, 30_000); // notBefore = 30_000
    const err = expectDomain(() => assertAttemptAllowed(r, 29_999), 'PIN_RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAt: 30_000 });
    // At exactly notBefore the window has elapsed — evaluation is permitted (no throw).
    expect(() => assertAttemptAllowed(r, 30_000)).not.toThrow();
    expect(() => assertAttemptAllowed(r, 45_000)).not.toThrow();
  });

  it('clock rollback keeps the stored notBefore standing (never recomputed downward)', () => {
    const r = row(5, 120_000);
    // now rolled far back: still refused, retryAt unchanged.
    const err = expectDomain(() => assertAttemptAllowed(r, -3_600_000), 'PIN_RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAt: 120_000 });
  });

  it('locked_out: every attempt throws PIN_LOCKED regardless of the clock (counter-based)', () => {
    const r = row(10, null);
    expectDomain(() => assertAttemptAllowed(r, 0), 'PIN_LOCKED');
    expectDomain(() => assertAttemptAllowed(r, 999_999_999), 'PIN_LOCKED');
  });

  it('POSITIVE CONTROL — an unlocked row and a delayed row past its window do NOT throw (T-14b)', () => {
    expect(() => assertAttemptAllowed(null, 0)).not.toThrow();
    expect(() => assertAttemptAllowed(row(2, null), 0)).not.toThrow();
    expect(() => assertAttemptAllowed(row(4, 100), 100)).not.toThrow();
  });
});

describe('SEC-AUTH-02/05 — success resets, and the recovery transitions', () => {
  it('recordSuccess resets the counter to 0 from unlocked/delayed', () => {
    expect(recordSuccess(row(2, null), U, D)).toEqual(clearedRow(U, D));
    expect(recordSuccess(row(9, 300_000), U, D)).toEqual(clearedRow(U, D));
  });

  it('recordSuccess/recordFailure from locked_out is INVALID_TRANSITION (03 §9.2)', () => {
    expectDomain(() => recordSuccess(row(10, null), U, D), 'INVALID_TRANSITION');
    expectDomain(() => recordFailure(row(10, null), U, D, 1), 'INVALID_TRANSITION');
  });

  it('clearLockout resets ONLY from locked_out; from any other state it is INVALID_TRANSITION', () => {
    expect(clearLockout(row(10, null), U, D)).toEqual(clearedRow(U, D));
    expectDomain(() => clearLockout(row(5, 120_000), U, D), 'INVALID_TRANSITION');
    expectDomain(() => clearLockout(row(0, null), U, D), 'INVALID_TRANSITION');
    expectDomain(() => clearLockout(null, U, D), 'INVALID_TRANSITION');
  });

  it('resetForNewVerifier clears the counter from ANY state (PIN-reset side effect, §6.5)', () => {
    expect(resetForNewVerifier(U, D)).toEqual(clearedRow(U, D));
  });
});
