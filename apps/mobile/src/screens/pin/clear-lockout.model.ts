/**
 * Owner "unlock a PIN" view model (api/02-auth §6.5.1; 03-state-machines §9.2 `locked_out → unlocked`).
 *
 * The use case: a cashier knows their PIN, but a colleague burned the attempts and hard-locked the
 * account. A user holding `auth.pin_unlock` clears the counter so they can try again — NO PIN reset,
 * the PIN is unchanged. Enforcement is core's: `clearPinLockoutFlow` checks the permission, requires
 * the target to actually be locked (`INVALID_TRANSITION` otherwise), and does the counter reset under
 * the same attempt lock `verifyPin` uses. This model only decides what the screen shows.
 *
 * The list itself (and its permission-first gate) is `staff-pin.model.ts`. `clearLockoutOutcome` maps the flow's `INVALID_TRANSITION` (the target got unlocked out from
 *     under us — a race, or someone else cleared it) to a truthful "no longer locked" message rather
 *     than a false success.
 */
import type { PinTargetUser } from './pin-target.js';

/** Why a clear attempt failed (a success needs no reason). */
export type ClearFailure = 'notLocked' | 'error';

/** The action sub-flow: pick a locked user → confirm → run the flow → success or failure. */
export type ClearAction =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming'; readonly target: PinTargetUser }
  | { readonly kind: 'submitting'; readonly target: PinTargetUser }
  | { readonly kind: 'done'; readonly target: PinTargetUser }
  | { readonly kind: 'failed'; readonly target: PinTargetUser; readonly reason: ClearFailure };

export const CLEAR_IDLE: ClearAction = { kind: 'idle' };

export type ClearEvent =
  | { readonly kind: 'pick'; readonly target: PinTargetUser }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'settled';
      readonly result:
        { readonly ok: true } | { readonly ok: false; readonly reason: ClearFailure };
    }
  | { readonly kind: 'dismiss' };

/**
 * The action transition. Total and defensive — an event that does not fit the current state (a double
 * confirm, a settle after dismissal) leaves it unchanged. A confirm is REQUIRED before submitting: an
 * unlock cannot fire straight from a tap, so a mis-tap never silently clears someone's lockout.
 */
export function clearActionReducer(action: ClearAction, event: ClearEvent): ClearAction {
  switch (action.kind) {
    case 'idle':
      return event.kind === 'pick' ? { kind: 'confirming', target: event.target } : action;
    case 'confirming':
      if (event.kind === 'confirm') return { kind: 'submitting', target: action.target };
      if (event.kind === 'cancel') return CLEAR_IDLE;
      return action;
    case 'submitting':
      if (event.kind === 'settled') {
        return event.result.ok
          ? { kind: 'done', target: action.target }
          : { kind: 'failed', target: action.target, reason: event.result.reason };
      }
      return action;
    case 'done':
    case 'failed':
      return event.kind === 'dismiss' ? CLEAR_IDLE : action;
  }
}

/**
 * Map the DomainError `clearPinLockoutFlow` throws to a failure reason. `INVALID_TRANSITION` means the
 * target was not locked when the flow ran (a race — someone else cleared it, or a later attempt reset
 * the counter): a truthful "no longer locked", not an error and never a false success. Everything else
 * is an unexpected failure.
 */
export function clearLockoutOutcome(error: unknown): { ok: false; reason: ClearFailure } {
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  return { ok: false, reason: code === 'INVALID_TRANSITION' ? 'notLocked' : 'error' };
}
