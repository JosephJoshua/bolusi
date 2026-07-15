// The PIN pad renders task 14's machine (03-state-machines §9; api/02-auth §6.5) without
// re-implementing it. Per this task's brief, SEC-AUTH-02/03/04 are task 14's tests — these assert
// what the SCREEN does with 14's states.
//
// Every threshold and delay below comes from 14's exported constants. There is no `10` and no
// `30_000` in this file: a test that restated the schedule would keep passing after 03 §9.1 moved,
// which is the drift it exists to catch (testing-guide §3.6).
import {
  delayMsForFailureCount,
  derivePinAuthState,
  PIN_FREE_ATTEMPTS,
  PIN_HARD_LOCK_THRESHOLD,
  PIN_LOCKOUT_SCHEDULE,
  type PinAttemptRow,
} from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import {
  attemptsLeft,
  canAttempt,
  PIN_MESSAGE_KEY,
  pinPadState,
  pinView,
  showsForgotAffordance,
  type PinView,
} from './model.js';

const NOW = 1_700_000_000_000;
const USER = 'user-a';
const DEVICE = 'device-1';

/** A `pin_attempt_state` row at `failures` consecutive failures, with 14's own window applied. */
function row(failures: number, notBefore: number | null = null): PinAttemptRow {
  return {
    userId: USER,
    deviceId: DEVICE,
    consecutiveFailures: failures,
    windowStartedAt: failures > 0 ? NOW : null,
    notBefore,
  };
}

describe('the view renders 14`s derived state — it never re-derives it', () => {
  test('a clean slate is entry, with the keys live', () => {
    expect(pinView(null, NOW)).toEqual({ kind: 'entry' });
    expect(pinPadState(pinView(null, NOW))).toBe('entry');
    expect(canAttempt(null, NOW)).toBe(true);
  });

  test('the free band (1..3 failures) stays live — 03 §9.1: attempts 1–3 are free', () => {
    for (let failures = 1; failures < PIN_FREE_ATTEMPTS; failures += 1) {
      const given = row(failures);
      expect(derivePinAuthState(given)).toBe('unlocked');
      expect(canAttempt(given, NOW)).toBe(true);
      expect(pinView(given, NOW, 'wrong')).toEqual({
        kind: 'wrong',
        attemptsLeft: PIN_HARD_LOCK_THRESHOLD - failures,
      });
    }
  });

  test('a wrong PIN shows auth.pin.attemptsLeft, counted from 14`s threshold', () => {
    const view = pinView(row(1), NOW, 'wrong');
    expect(view).toEqual({ kind: 'wrong', attemptsLeft: PIN_HARD_LOCK_THRESHOLD - 1 });
    expect(PIN_MESSAGE_KEY[view.kind]).toBe('auth.pin.wrong');
    expect(pinPadState(view)).toBe('error');
  });

  test('attemptsLeft tracks the row and never goes negative', () => {
    expect(attemptsLeft(null)).toBe(PIN_HARD_LOCK_THRESHOLD);
    expect(attemptsLeft(row(1))).toBe(PIN_HARD_LOCK_THRESHOLD - 1);
    expect(attemptsLeft(row(PIN_HARD_LOCK_THRESHOLD))).toBe(0);
    // A row somehow past the threshold must not render "sisa -3 kesempatan".
    expect(attemptsLeft(row(PIN_HARD_LOCK_THRESHOLD + 5))).toBe(0);
  });
});

describe('`delayed` — the countdown, and NO verify call while now < notBefore', () => {
  // The schedule's own first window, read from 14 rather than written here.
  const firstDelay = delayMsForFailureCount(PIN_FREE_ATTEMPTS);
  const delayedRow = row(PIN_FREE_ATTEMPTS, NOW + firstDelay);

  test('the machine agrees this row is `delayed` (the fixture is not lying)', () => {
    // T-14b: pin the fixture against 14's own derivation, so a schedule change cannot leave this
    // suite quietly testing an `unlocked` row while claiming to test `delayed`.
    expect(derivePinAuthState(delayedRow)).toBe('delayed');
    expect(firstDelay).toBe(PIN_LOCKOUT_SCHEDULE[0].delayMs);
  });

  test('inside the window the keys are dead and NO attempt is permitted', () => {
    expect(canAttempt(delayedRow, NOW)).toBe(false);
    expect(canAttempt(delayedRow, NOW + firstDelay - 1)).toBe(false);
    const view = pinView(delayedRow, NOW);
    expect(view).toEqual({ kind: 'delayed', remainingMs: firstDelay });
    expect(pinPadState(view)).toBe('locked');
    expect(PIN_MESSAGE_KEY[view.kind]).toBe('auth.pin.wait');
  });

  test('the countdown shrinks toward zero as the clock advances', () => {
    const at = (now: number): number =>
      (pinView(delayedRow, now) as Extract<PinView, { kind: 'delayed' }>).remainingMs;
    expect(at(NOW)).toBe(firstDelay);
    expect(at(NOW + firstDelay / 2)).toBe(firstDelay / 2);
    expect(at(NOW + firstDelay - 1)).toBe(1);
  });

  test('AT notBefore the window is open again — the wait is finite, as the copy promises', () => {
    expect(canAttempt(delayedRow, NOW + firstDelay)).toBe(true);
    expect(pinView(delayedRow, NOW + firstDelay)).toEqual({ kind: 'entry' });
  });

  test('a rolled-back clock cannot open the window early (SEC-AUTH-04`s UI arm)', () => {
    // 14 stores `notBefore` as an ms epoch and never recomputes it downward. Winding the device
    // clock back must therefore make the countdown read LONGER, never shorter, and must never
    // re-enable the keys.
    const rolledBack = NOW - firstDelay * 10;
    expect(canAttempt(delayedRow, rolledBack)).toBe(false);
    const view = pinView(delayedRow, rolledBack) as Extract<PinView, { kind: 'delayed' }>;
    expect(view.kind).toBe('delayed');
    expect(view.remainingMs).toBeGreaterThan(firstDelay);
  });

  test('every scheduled window keeps the keys dead for its whole duration (03 §9.1)', () => {
    // Test the CLASS, not one instance (T-12): walk 14's whole schedule.
    let covered = 0;
    for (const { consecutiveFailures, delayMs } of PIN_LOCKOUT_SCHEDULE) {
      const gated = row(consecutiveFailures, NOW + delayMs);
      expect(derivePinAuthState(gated), `failures=${consecutiveFailures}`).toBe('delayed');
      expect(canAttempt(gated, NOW + delayMs - 1)).toBe(false);
      expect(canAttempt(gated, NOW + delayMs)).toBe(true);
      covered += 1;
    }
    // The loop's own denominator (T-14): an empty schedule would otherwise report green.
    expect(covered).toBe(PIN_LOCKOUT_SCHEDULE.length);
    expect(covered).toBeGreaterThan(0);
  });
});

describe('`locked_out` — the hard lock, and what it must not say', () => {
  const lockedRow = row(PIN_HARD_LOCK_THRESHOLD);

  test('the machine agrees the fixture is locked_out', () => {
    expect(derivePinAuthState(lockedRow)).toBe('locked_out');
  });

  test('renders auth.pin.lockedOut with the keys dead and no attempt permitted', () => {
    const view = pinView(lockedRow, NOW);
    expect(view).toEqual({ kind: 'lockedOut' });
    expect(canAttempt(lockedRow, NOW)).toBe(false);
    expect(pinPadState(view)).toBe('locked');
    expect(PIN_MESSAGE_KEY[view.kind]).toBe('auth.pin.lockedOut');
  });

  test('offers the auth.pin.forgot affordance — and ONLY here, where it is actionable', () => {
    expect(showsForgotAffordance(pinView(lockedRow, NOW))).toBe(true);
    expect(showsForgotAffordance(pinView(null, NOW))).toBe(false);
    expect(showsForgotAffordance(pinView(row(1), NOW, 'wrong'))).toBe(false);
    expect(showsForgotAffordance(pinView(row(PIN_FREE_ATTEMPTS, NOW + 1), NOW))).toBe(false);
  });

  test('waiting does NOT clear a hard lock — time is not the recovery path (api/02-auth §6.5)', () => {
    // The lock is counter-based and clock-independent. A countdown here would be a lie: it would
    // promise a technician that standing still fixes it, when only the store owner can.
    for (const later of [NOW + 1, NOW + 86_400_000, NOW + 86_400_000 * 365]) {
      expect(pinView(lockedRow, later)).toEqual({ kind: 'lockedOut' });
      expect(canAttempt(lockedRow, later)).toBe(false);
    }
  });

  test('the hard lock beats both `delayed` and `wrong` — one message, the one that helps', () => {
    // At the 10th failure the row is also inside a window and the attempt was also wrong. Showing
    // "sisa 0 kesempatan" would be true and useless.
    const both = row(
      PIN_HARD_LOCK_THRESHOLD,
      NOW + delayMsForFailureCount(PIN_HARD_LOCK_THRESHOLD),
    );
    expect(pinView(both, NOW, 'wrong')).toEqual({ kind: 'lockedOut' });
  });
});

describe('the view is total — no state maps to a blank screen (task 24 acceptance)', () => {
  test('every (failures × window × lastAttempt) combination renders a known state', () => {
    const kinds = new Set<PinView['kind']>();
    let count = 0;

    for (let failures = 0; failures <= PIN_HARD_LOCK_THRESHOLD + 1; failures += 1) {
      for (const notBefore of [null, NOW - 1, NOW, NOW + 1_000]) {
        for (const last of ['none', 'wrong'] as const) {
          const view = pinView(failures === 0 ? null : row(failures, notBefore), NOW, last);
          expect(view).toBeDefined();
          expect(pinPadState(view)).toBeTruthy();
          // Every kind resolves a message slot — `entry` legitimately has none.
          expect(PIN_MESSAGE_KEY).toHaveProperty(view.kind);
          kinds.add(view.kind);
          count += 1;
        }
      }
    }

    // The sweep's own denominator (T-14): without this a zero-iteration loop reports green.
    expect(count).toBe((PIN_HARD_LOCK_THRESHOLD + 2) * 4 * 2);
    // And it must actually have reached every state, not just the easy ones.
    expect([...kinds].sort()).toEqual(['delayed', 'entry', 'lockedOut', 'wrong']);
  });
});
