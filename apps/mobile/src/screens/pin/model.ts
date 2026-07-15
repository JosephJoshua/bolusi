/**
 * The PIN pad's view model (design-system §8.3/§3.3; api/02-auth §6.1/§6.5; 03-state-machines §9).
 *
 * THE ONE RULE THIS FILE OBEYS: it renders task 14's machine and re-implements NOTHING. The state
 * comes from 14's `derivePinAuthState`, the threshold from 14's `PIN_HARD_LOCK_THRESHOLD`, the
 * window from the row's own `notBefore`. There is no second copy of the escalation schedule here,
 * and no `10` written down — if 03 §9.1 changes, this screen follows without being touched. A UI
 * that re-derives a security machine is a UI that can disagree with it, and the disagreement always
 * favours the attacker (a screen that thinks you have attempts left when you do not is merely
 * annoying; one that thinks you are unlocked when you are locked is a bypass).
 *
 * WHY A COUNTDOWN AND NOT A SPINNER — the human problem this screen actually solves. After the 3rd
 * wrong PIN a cashier is locked out for 30 s, then 60, then 120, then 300. To a tech-inadept user
 * mid-transaction, an unresponsive keypad is indistinguishable from a broken app, and the rational
 * response to a broken app is to keep tapping — which, if the keys were live, would burn the
 * remaining attempts and hard-lock the account. So the wait is shown as a SHRINKING NUMBER: it says
 * the app is working, the wait is finite, and tapping will not help. `auth.pin.wait` is
 * "Terlalu banyak salah. Tunggu {duration}." — the countdown fills `{duration}`.
 *
 * AND WHY `lockedOut` MUST NOT MENTION A SERVER. At 10 failures the user is locked out OFFLINE, and
 * recovery is offline too (api/02-auth §6.5: owner unlock, or owner PIN reset — "There is no online
 * self-recovery"). The copy already reflects that: `auth.pin.lockedOut` is "PIN terkunci. Minta
 * pemilik toko untuk membukanya." — ask the store owner. Never "try again later" (time does not fix
 * a hard lock) and never "contact support" (there is no support, and the store owner CAN fix it,
 * offline, right now). Getting this wrong means a shop that cannot take payments waits for a network
 * that was never going to help.
 */

import {
  derivePinAuthState,
  PIN_HARD_LOCK_THRESHOLD,
  type PinAttemptRow,
  type PinAuthState,
} from '@bolusi/core';

/**
 * What the PIN screen shows. A discriminated union so the renderer's switch is exhaustive — that is
 * how "no state maps to a blank screen" (this task's acceptance) is bought at compile time rather
 * than hoped for.
 */
export type PinView =
  /** Ready for input. The only state in which the keys are live. */
  | { readonly kind: 'entry' }
  /** The last attempt was wrong and more remain — `auth.pin.wrong` + `auth.pin.attemptsLeft`. */
  | { readonly kind: 'wrong'; readonly attemptsLeft: number }
  /** Inside an escalation window (03 §9.1) — `auth.pin.wait` with a live countdown. */
  | { readonly kind: 'delayed'; readonly remainingMs: number }
  /** Hard lock (10 failures) — `auth.pin.lockedOut` + the `auth.pin.forgot` affordance. */
  | { readonly kind: 'lockedOut' };

/** Did the attempt just made come back wrong? Drives the transient `wrong` message only. */
export type LastAttempt = 'none' | 'wrong';

/**
 * Attempts remaining before the hard lock (03 §9.1). Derived from 14's threshold — never a literal.
 * Clamped at 0 so a row somehow past the threshold cannot render a negative count.
 */
export function attemptsLeft(row: PinAttemptRow | null): number {
  return Math.max(0, PIN_HARD_LOCK_THRESHOLD - (row?.consecutiveFailures ?? 0));
}

/**
 * Is an attempt allowed to reach the KDF right now?
 *
 * This MIRRORS 14's `assertAttemptAllowed` gate; it does not replace it. 14's gate is the
 * enforcement (SEC-AUTH-02: no argon2id, no timing oracle, and it throws); this is the AFFORDANCE —
 * what lets the screen keep the keys dark instead of accepting taps that are guaranteed to throw.
 * Both must agree, and both read the same `notBefore` from the same row, so they cannot drift.
 *
 * Belt AND braces on purpose: even if this returned true wrongly, 14's gate still refuses. The
 * reverse — a screen that fires a verify into a closed window — is what this prevents.
 */
export function canAttempt(row: PinAttemptRow | null, now: number): boolean {
  const state = derivePinAuthState(row);
  if (state === 'locked_out') return false;
  if (state === 'delayed' && row?.notBefore !== null && row !== null) {
    return now >= row.notBefore;
  }
  return true;
}

/**
 * The view for a `(row, now)` pair. Total: every `PinAuthState` maps to a rendered state, so no
 * combination reaches a blank screen.
 *
 * Precedence is deliberate — `lockedOut` beats `delayed` beats `wrong`. A user who has just hit the
 * 10th failure is both "wrong" and "locked"; telling them "PIN salah, sisa 0 kesempatan" would be
 * true and useless. What they need is the one thing that fixes it: ask the store owner.
 */
export function pinView(
  row: PinAttemptRow | null,
  now: number,
  lastAttempt: LastAttempt = 'none',
): PinView {
  const state: PinAuthState = derivePinAuthState(row);

  if (state === 'locked_out') return { kind: 'lockedOut' };

  if (state === 'delayed' && row !== null && row.notBefore !== null && now < row.notBefore) {
    // Never negative, and never trusts the device clock downward: `notBefore` is a stored ms epoch
    // that 14 refuses to recompute (SEC-AUTH-04), so a rolled-back clock only makes the countdown
    // read LONGER — it can never open the window early.
    return { kind: 'delayed', remainingMs: Math.max(0, row.notBefore - now) };
  }

  if (lastAttempt === 'wrong') return { kind: 'wrong', attemptsLeft: attemptsLeft(row) };

  return { kind: 'entry' };
}

/** The label key each view renders. Keys only — copy lives in the catalog (07-i18n). */
export const PIN_MESSAGE_KEY = {
  entry: null,
  wrong: 'auth.pin.wrong',
  delayed: 'auth.pin.wait',
  lockedOut: 'auth.pin.lockedOut',
} as const satisfies Record<PinView['kind'], string | null>;

/** design-system §3.3: the PinPad's own state. `delayed` and `lockedOut` both disable the keys. */
export function pinPadState(view: PinView): 'entry' | 'error' | 'locked' {
  switch (view.kind) {
    case 'entry':
      return 'entry';
    case 'wrong':
      return 'error';
    case 'delayed':
    case 'lockedOut':
      return 'locked';
  }
}

/** §8.3: the `auth.pin.forgot` affordance appears only where it is actionable — the hard lock. */
export function showsForgotAffordance(view: PinView): boolean {
  return view.kind === 'lockedOut';
}
