/**
 * Owner PIN-reset view model (api/02-auth §6.6 "Reset (owner)"; 02-permissions §5.4.6).
 *
 * The use case: a colleague forgot their PIN. An owner (`auth.user_reset_pin`) opens that user and
 * THE TARGET USER types a new PIN — the owner never learns it (§6.6). So the flow is: choose a target
 * → hand the device over → the target enters a new PIN and repeats it → reset. Core's `resetPin`
 * enforces the permission, the directory-membership restriction, and the §6.6 privileged-target rule
 * (only a main owner may reset another main owner); this model decides what the screen shows.
 *
 * The list (permission first, the acting owner left out) is `staff-pin.model.ts`. Two decisions
 * live here:
 *  1. The reset is only submittable after the shared `advanceNewPin` sub-flow reaches `matched` — the
 *     target's repeat must equal their first entry, so a mistyped confirmation never sets a PIN the
 *     target cannot reproduce (which would lock them straight back out).
 *  2. `resetOutcome` maps the flow's `restriction_violated` denial to the truthful privileged-target
 *     message, never a false success.
 */
import { advanceNewPin, NEW_PIN_START, type NewPinEntry } from './new-pin.js';
import type { PinTargetUser } from './pin-target.js';

/** Why a reset failed (a success needs no reason). */
export type ResetFailure = 'denied' | 'error';

/** The action sub-flow: choose a target → hand over → target enters the new PIN → reset. */
export type ResetPhase =
  | { readonly kind: 'list' }
  /** Target chosen; the owner is prompted to hand the device to them. */
  | { readonly kind: 'handOver'; readonly target: PinTargetUser }
  /** The target is entering (and repeating) their new PIN via the shared sub-flow. */
  | { readonly kind: 'entering'; readonly target: PinTargetUser; readonly entry: NewPinEntry }
  /** Confirmed new PIN in hand — the caller is running `auth.resetPin`. */
  | { readonly kind: 'submitting'; readonly target: PinTargetUser; readonly newPin: string }
  | { readonly kind: 'done'; readonly target: PinTargetUser }
  | { readonly kind: 'failed'; readonly target: PinTargetUser; readonly reason: ResetFailure };

export const RESET_LIST: ResetPhase = { kind: 'list' };

export type ResetEvent =
  | { readonly kind: 'pick'; readonly target: PinTargetUser }
  | { readonly kind: 'proceed' }
  | { readonly kind: 'enteredPin'; readonly pin: string }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'settled';
      readonly result:
        { readonly ok: true } | { readonly ok: false; readonly reason: ResetFailure };
    }
  | { readonly kind: 'dismiss' };

/**
 * The pure transition. Total and defensive. The `matched` gate is the security-relevant edge: an
 * unequal repeat keeps the sub-flow in `entering` (it can never become `submitting`), and only the
 * `matched` result carries the PIN forward — so a mistyped confirmation cannot be reset onto the user.
 */
export function resetPinReducer(phase: ResetPhase, event: ResetEvent): ResetPhase {
  switch (phase.kind) {
    case 'list':
      return event.kind === 'pick' ? { kind: 'handOver', target: event.target } : phase;
    case 'handOver':
      if (event.kind === 'proceed') {
        return { kind: 'entering', target: phase.target, entry: NEW_PIN_START };
      }
      if (event.kind === 'cancel') return RESET_LIST;
      return phase;
    case 'entering': {
      if (event.kind === 'cancel') return RESET_LIST;
      if (event.kind !== 'enteredPin') return phase;
      const entry = advanceNewPin(phase.entry, event.pin);
      if (entry.kind === 'matched') {
        return { kind: 'submitting', target: phase.target, newPin: entry.pin };
      }
      return { kind: 'entering', target: phase.target, entry };
    }
    case 'submitting':
      if (event.kind === 'settled') {
        return event.result.ok
          ? { kind: 'done', target: phase.target }
          : { kind: 'failed', target: phase.target, reason: event.result.reason };
      }
      return phase;
    case 'done':
    case 'failed':
      return event.kind === 'dismiss' ? RESET_LIST : phase;
  }
}

/**
 * Map the DomainError `resetPin` throws to a failure reason. A `PERMISSION_DENIED` carrying
 * `reason: 'restriction_violated'` is the §6.6 privileged-target rule (only a main owner may reset a
 * main owner) — the only restriction reachable from this screen, since the targets all come from the
 * directory. Everything else is an unexpected failure; a denial is never reported as a success.
 */
export function resetOutcome(error: unknown): { ok: false; reason: ResetFailure } {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    const details = (error as { details?: { reason?: unknown } }).details;
    if (code === 'PERMISSION_DENIED' && details?.reason === 'restriction_violated') {
      return { ok: false, reason: 'denied' };
    }
  }
  return { ok: false, reason: 'error' };
}
