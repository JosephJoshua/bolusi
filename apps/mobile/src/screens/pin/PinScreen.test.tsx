// The PIN screen APPLIES task 14's decision — this file renders the real screen to prove it.
//
// ── WHY THIS FILE EXISTS (task 69, the third layer of task 60's finding) ────────────────────────
// `model.test.ts` covers `pinPadState`/`pinView` — the functions that DECIDE whether the keys are
// live. It cannot see whether `PinScreen` PERFORMS the composition it tests: nothing there renders
// the screen. `PinScreen` wires the pad with `<PinPad state={pinPadState(view)} …/>`; replace that
// with `state="entry"` and the keys go live inside every lockout window — the exact bug 60 exists to
// protect against — while all 16 assertions in `model.test.ts` stay green (a helper that mirrors the
// screen's wiring cannot detect the screen's wiring changing).
//
// This file mounts the REAL screen on the existing render lane (08 §5.4; the same lane
// `EnrollmentScreen.test.tsx` / `SettingsScreen.test.tsx` use) and asserts, at the render boundary,
// that the pad's keys are DISABLED and UNWIRED in the `delayed` and `lockedOut` states. It is the
// assertion that would fail if `state=` were hardcoded, and it is the whole point of task 69.
//
// FALSIFIED (§2.11 / T-14): hardcoding `state="entry"` in `PinScreen` turns the two lockout tests
// below RED (the keys are live during a lockout) while `model.test.ts` stays 16/16 green — proving
// the two lanes cover different things, which is the finding. The `entry` positive control (T-14b)
// keeps the disabled-in-lockout claim honest: it proves the green comes from the SCREEN wiring the
// state through, not from a pad that happens to disable its keys unconditionally.
//
// The disabled/unwired state read back is public component BEHAVIOUR (accessibilityState + the
// absence of an onPress handler), never rendered copy — testing-guide T-4.
import {
  delayMsForFailureCount,
  derivePinAuthState,
  PIN_FREE_ATTEMPTS,
  PIN_HARD_LOCK_THRESHOLD,
  type PinAttemptRow,
  type PinAuthState,
} from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { isUnwired, render } from '../../../../../packages/ui/test/render.js';

import { PinScreen } from './PinScreen.js';

const NOW = 1_700_000_000_000;
const USER = 'user-a';
const DEVICE = 'device-1';

/** The 11 pressable keys the pad renders (design-system §3.3): digits 0–9 and backspace. */
const KEYS = [...'0123456789', 'backspace'];

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

function renderPin(over: { row: PinAttemptRow | null; now?: number }) {
  return render(
    <PinScreen
      userId={USER}
      userName="Kasir 1"
      row={over.row}
      now={over.now ?? NOW}
      lastAttempt="none"
      onSubmit={vi.fn()}
      onSwitchUser={vi.fn()}
      syncChip="synced"
      onOpenSync={vi.fn()}
    />,
  );
}

// The two lockout rows, each pinned against 14's own derivation (T-14b): a schedule change cannot
// leave this suite quietly rendering an `entry` row while claiming to test a lockout, which would
// make the guard below a no-op.
const LOCKOUTS: ReadonlyArray<{
  readonly name: string;
  readonly state: PinAuthState;
  readonly row: PinAttemptRow;
}> = [
  {
    name: 'delayed',
    state: 'delayed',
    row: row(PIN_FREE_ATTEMPTS, NOW + delayMsForFailureCount(PIN_FREE_ATTEMPTS)),
  },
  {
    name: 'lockedOut',
    state: 'locked_out',
    row: row(PIN_HARD_LOCK_THRESHOLD),
  },
];

describe('PinScreen wires the pad state through — the keys are dead inside a lockout window', () => {
  for (const { name, state, row: lockoutRow } of LOCKOUTS) {
    test(`${name}: the fixture really is ${state} (T-14b — the fixture is not lying)`, () => {
      expect(derivePinAuthState(lockoutRow)).toBe(state);
    });

    test(`${name}: every one of the 11 keys is announced disabled AND carries no onPress`, () => {
      const screen = renderPin({ row: lockoutRow });
      expect(KEYS).toHaveLength(11);
      for (const key of KEYS) {
        const node = screen.get(`pin-pad.key.${key}`);
        // Announced disabled to assistive tech…
        expect(node.props['accessibilityState'], `key=${key}`).toEqual({ disabled: true });
        // …and inert: a locked key drops its handler, so a tap can never reach `onComplete`. This is
        // the line that goes live if `PinScreen` hardcodes `state="entry"`.
        expect(isUnwired(node), `key=${key}`).toBe(true);
      }
    });
  }

  test('POSITIVE CONTROL: a clean slate leaves the keys LIVE — the screen does not disable everything', () => {
    // Without this, both lockout tests above would pass on a screen that hardcoded `state="locked"`
    // (a pad that can never take a PIN). This proves the disabled state is DRIVEN by the row: hand a
    // clean slate, get live keys.
    const screen = renderPin({ row: null });
    expect(derivePinAuthState(null)).toBe('unlocked');
    for (const key of KEYS) {
      const node = screen.get(`pin-pad.key.${key}`);
      expect(node.props['accessibilityState'], `key=${key}`).toEqual({ disabled: false });
      expect(isUnwired(node), `key=${key}`).toBe(false);
    }
  });
});
