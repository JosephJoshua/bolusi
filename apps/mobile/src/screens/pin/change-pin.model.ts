/**
 * Change-your-own-PIN view model (api/02-auth §6.6 "Change (self)"; design-system §8.3).
 *
 * THE FLOW IS ATOMIC AND SELF-ONLY, AND THIS MODEL DOES NOT SECOND-GUESS IT. `auth.changePin`
 * (core `pin-flows.ts`) verifies the CURRENT PIN locally, then computes and applies the new verifier —
 * one operation. A wrong current PIN throws before any new verifier is written and burns a lockout
 * attempt exactly as a wrong PIN at the lock screen does (that IS the control: the change screen must
 * not be a lockout-free oracle for guessing a PIN). So this screen collects current → new → repeat,
 * hands both to the flow, and RESTARTS at the current step if the flow rejects the current PIN. It
 * re-implements neither the current-PIN check nor the lockout machine (CLAUDE.md §2.8); it only maps
 * the flow's DomainError to what the pad shows.
 *
 * The new-PIN half is the shared `advanceNewPin` sub-flow — the same "type it, repeat it, they must
 * match" the owner-reset screen uses — so a mistyped confirmation can never submit here either.
 */
import { advanceNewPin, NEW_PIN_START, newPinMessageKey, type NewPinEntry } from './new-pin.js';

/** Why the current-PIN step is unhappy. `none` is the clean first render. */
export type ChangeFeedback = 'none' | 'wrongCurrent' | 'locked' | 'rateLimited' | 'error';

/**
 * The screen's phase. A discriminated union so the renderer's switch is exhaustive — no combination
 * reaches a blank pad (design-system §5 "no state maps to a blank screen").
 *
 * `currentPin` lives in memory only while the flow runs; it is never persisted or logged (this model
 * has no I/O), and a failed attempt drops it by returning to `current`.
 */
export type ChangePinPhase =
  /** Awaiting the current PIN. `feedback` shows why a prior attempt failed. */
  | { readonly kind: 'current'; readonly feedback: ChangeFeedback }
  /** Current PIN captured; collecting the new PIN + its repeat via the shared sub-flow. */
  | { readonly kind: 'new'; readonly currentPin: string; readonly entry: NewPinEntry }
  /** Both PINs in hand and confirmed equal — the caller is running `auth.changePin`. */
  | { readonly kind: 'submitting'; readonly currentPin: string; readonly newPin: string }
  /** The PIN changed. Terminal — the screen shows a success state, not the pad. */
  | { readonly kind: 'done' };

export const CHANGE_PIN_START: ChangePinPhase = { kind: 'current', feedback: 'none' };

/** What the caller reports back after running `auth.changePin`. */
export type ChangePinResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: Exclude<ChangeFeedback, 'none'> };

/** Reducer events: a completed 6-digit entry per step, or the flow settling. */
export type ChangePinEvent =
  | { readonly kind: 'enteredCurrent'; readonly pin: string }
  | { readonly kind: 'enteredNew'; readonly pin: string }
  | { readonly kind: 'settled'; readonly result: ChangePinResult };

/**
 * The pure transition. Total and defensive: an event that does not match the current phase (a late
 * PIN-pad completion after we already moved on) returns the phase unchanged rather than corrupting it.
 *
 * The one security-relevant edge is the `settled` arm — a NON-ok result NEVER reaches `done`; it
 * returns to `current` carrying the reason. `change-pin.model.test.ts` drives each failure reason and
 * asserts the phase is `current`, so a refactor that let a rejected change read as success fails there.
 */
export function changePinReducer(phase: ChangePinPhase, event: ChangePinEvent): ChangePinPhase {
  switch (phase.kind) {
    case 'current':
      if (event.kind === 'enteredCurrent') {
        return { kind: 'new', currentPin: event.pin, entry: NEW_PIN_START };
      }
      return phase;
    case 'new': {
      if (event.kind !== 'enteredNew') return phase;
      const entry = advanceNewPin(phase.entry, event.pin);
      if (entry.kind === 'matched') {
        return { kind: 'submitting', currentPin: phase.currentPin, newPin: entry.pin };
      }
      return { kind: 'new', currentPin: phase.currentPin, entry };
    }
    case 'submitting':
      if (event.kind === 'settled') {
        return event.result.ok
          ? { kind: 'done' }
          : { kind: 'current', feedback: event.result.reason };
      }
      return phase;
    case 'done':
      return phase;
  }
}

/**
 * Map the DomainError `auth.changePin` throws (api/02-auth §6.6) to the reason the current step shows.
 * Read structurally by `code` rather than via `instanceof`, so the mapping is a pure function of the
 * error's shape and does not depend on a single class instance surviving the bundler.
 *
 *   NOT_AUTHENTICATED → the current PIN was wrong (the flow's own `reason: 'current_pin_incorrect'`).
 *   PIN_LOCKED        → the account hard-locked; only the owner can clear it (no self-recovery, §6.5).
 *   PIN_RATE_LIMITED  → inside an escalation window; retry is allowed but gated (no attempt burned).
 *   anything else     → an unexpected failure; surface it, never swallow it into a false success.
 */
export function changePinFailure(error: unknown): ChangePinResult {
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  switch (code) {
    case 'NOT_AUTHENTICATED':
      return { ok: false, reason: 'wrongCurrent' };
    case 'PIN_LOCKED':
      return { ok: false, reason: 'locked' };
    case 'PIN_RATE_LIMITED':
      return { ok: false, reason: 'rateLimited' };
    default:
      return { ok: false, reason: 'error' };
  }
}

/** The PIN-pad message key for a phase (keys only; copy lives in the catalog — 07-i18n). */
export type ChangePinMessageKey =
  | 'auth.pin.change.enterCurrent'
  | 'auth.pin.change.wrongCurrent'
  | 'auth.pin.lockedOut'
  | 'core.errors.PIN_RATE_LIMITED'
  | 'core.errors.UNEXPECTED'
  | 'auth.pin.setup.title'
  | 'auth.pin.setup.repeat'
  | 'auth.pin.setup.mismatch';

export function changeMessageKey(phase: ChangePinPhase): ChangePinMessageKey | null {
  switch (phase.kind) {
    case 'current':
      switch (phase.feedback) {
        case 'none':
          return 'auth.pin.change.enterCurrent';
        case 'wrongCurrent':
          return 'auth.pin.change.wrongCurrent';
        case 'locked':
          return 'auth.pin.lockedOut';
        case 'rateLimited':
          return 'core.errors.PIN_RATE_LIMITED';
        case 'error':
          return 'core.errors.UNEXPECTED';
      }
    // The inner switch is exhaustive over ChangeFeedback and every arm returns, so `current` never
    // falls through to `new`.
    case 'new':
      return newPinMessageKey(phase.entry);
    case 'submitting':
    case 'done':
      return null;
  }
}

/**
 * The PIN pad's own state (design-system §3.3). `locked` disables the keys — used ONLY for the hard
 * lock, where there is genuinely nothing to retry until the owner clears it. `rateLimited` stays
 * `error` (keys live): a retry inside the window is re-gated by the flow without burning an attempt,
 * so a live pad is honest and a dead one would strand a user who only has to wait a moment. Mismatch
 * shows `error` (red, cleared entry); the normal entry states are `entry`.
 */
export function changePadState(phase: ChangePinPhase): 'entry' | 'error' | 'locked' {
  switch (phase.kind) {
    case 'current':
      if (phase.feedback === 'locked') return 'locked';
      return phase.feedback === 'none' ? 'entry' : 'error';
    case 'new':
      return phase.entry.kind === 'first' && phase.entry.afterMismatch ? 'error' : 'entry';
    case 'submitting':
    case 'done':
      return 'entry';
  }
}
