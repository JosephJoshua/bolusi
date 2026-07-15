// The PinAuth lockout machine (api/02-auth §6.5; 03-state-machines §9 is its verbatim mirror).
//
// PURE + persisted-row-driven. The states are DERIVED from the `pin_attempt_state` row, never stored
// as a column (03 §9): `locked_out ⇔ failures ≥ 10`, `delayed ⇔ 3 ≤ failures < 10`, else `unlocked`.
// Everything here is a pure function over `(row, now)` — the DB read/write and the FakeClock live in
// the caller (pin-verify.ts / pin-flows.ts), so the schedule can be exercised on a FakeClock with no
// I/O and the "KDF never runs during a window" property is structural: the gate throws BEFORE the
// caller reaches the KDF (SEC-AUTH-02).
//
// The numbers are IMPORTED from constants.ts (`PIN_FREE_ATTEMPTS`, `PIN_HARD_LOCK_THRESHOLD`,
// `delayMsForFailureCount`) — this file contains no schedule literal, so CHAOS-11's
// imported-constants requirement holds by construction (testing-guide §3.6).
import { DomainError } from '../errors/domain-error.js';
import { PIN_FREE_ATTEMPTS, PIN_HARD_LOCK_THRESHOLD, delayMsForFailureCount } from './constants.js';
import type { PinAttemptRow } from './repo.js';

/** The PinAuth machine's derived states (03 §9). */
export type PinAuthState = 'unlocked' | 'delayed' | 'locked_out';

/** `consecutiveFailures` of a row (or 0 when there is no row). */
function failuresOf(row: PinAttemptRow | null): number {
  return row?.consecutiveFailures ?? 0;
}

/**
 * Derive the PinAuth state from the persisted row (03 §9 — states are derived, never stored). A
 * `null` row is a clean slate: `unlocked`.
 */
export function derivePinAuthState(row: PinAttemptRow | null): PinAuthState {
  const failures = failuresOf(row);
  if (failures >= PIN_HARD_LOCK_THRESHOLD) return 'locked_out';
  if (failures >= PIN_FREE_ATTEMPTS) return 'delayed';
  return 'unlocked';
}

/** A cleared row (counter 0, no window) — the shape after success / owner unlock / verifier reset. */
export function clearedRow(userId: string, deviceId: string): PinAttemptRow {
  return { userId, deviceId, consecutiveFailures: 0, windowStartedAt: null, notBefore: null };
}

/**
 * Gate an attempt BEFORE the KDF runs (api/02-auth §6.5; SEC-AUTH-02). The refusal is free — no
 * argon2id, no timing/battery oracle — and the outcome is the property: a wrong OR correct PIN
 * offered during a window never reaches the KDF, so it can never unlock.
 *
 * @throws {DomainError} `PIN_LOCKED` while `locked_out`; `PIN_RATE_LIMITED` (with `retryAt`) while
 *   `delayed` and `now < notBefore`. Clock rollback cannot shrink the window: `notBefore` is the
 *   stored ms epoch and is never recomputed here, so a smaller `now` only keeps `now < notBefore`
 *   true (SEC-AUTH-04).
 */
export function assertAttemptAllowed(row: PinAttemptRow | null, now: number): void {
  const state = derivePinAuthState(row);
  if (state === 'locked_out') {
    throw new DomainError(
      'PIN_LOCKED',
      { userId: row?.userId },
      'PIN auth is locked for this user on this device (api/02-auth §6.5)',
    );
  }
  if (state === 'delayed' && row !== null && row.notBefore !== null && now < row.notBefore) {
    throw new DomainError(
      'PIN_RATE_LIMITED',
      { retryAt: row.notBefore },
      'PIN attempt refused during the escalation window (api/02-auth §6.5)',
    );
  }
}

/** The outcome of recording an evaluated wrong-PIN attempt. */
export interface FailureOutcome {
  readonly row: PinAttemptRow;
  /** True iff this failure was the 10th consecutive — the caller must emit `auth.pin_locked_out`. */
  readonly lockedOut: boolean;
}

/**
 * Record an EVALUATED failure (api/02-auth §6.5): increment the counter, open the next window, and
 * flag the hard lock at the 10th. Reachable only once `assertAttemptAllowed` permitted the attempt,
 * so a `locked_out` starting state is an invalid transition (03 §9.2 "any other pair").
 *
 * The window is started at the FIRST failure of a streak and never moved earlier; `notBefore` is
 * `now + delay` for the count reached (0 delay ⇒ null while still in the free band).
 *
 * @throws {DomainError} `INVALID_TRANSITION` if the row is already `locked_out`.
 */
export function recordFailure(
  row: PinAttemptRow | null,
  userId: string,
  deviceId: string,
  now: number,
): FailureOutcome {
  if (derivePinAuthState(row) === 'locked_out') {
    throw invalidTransition('locked_out', 'pin_failed');
  }
  const consecutiveFailures = failuresOf(row) + 1;
  const windowStartedAt = row?.windowStartedAt ?? now;
  const delay = delayMsForFailureCount(consecutiveFailures);
  const notBefore = delay > 0 ? now + delay : null;
  return {
    row: { userId, deviceId, consecutiveFailures, windowStartedAt, notBefore },
    lockedOut: consecutiveFailures >= PIN_HARD_LOCK_THRESHOLD,
  };
}

/**
 * Record an EVALUATED success (api/02-auth §6.5): reset the counter to 0. Reachable only post-gate,
 * so a `locked_out` starting state is invalid (03 §9.2).
 *
 * @throws {DomainError} `INVALID_TRANSITION` if the row is already `locked_out`.
 */
export function recordSuccess(
  row: PinAttemptRow | null,
  userId: string,
  deviceId: string,
): PinAttemptRow {
  if (derivePinAuthState(row) === 'locked_out') {
    throw invalidTransition('locked_out', 'pin_succeeded');
  }
  return clearedRow(userId, deviceId);
}

/**
 * Owner unlock (03 §9.2: `locked_out → unlocked` via `auth.clearPinLockout`). Valid ONLY from
 * `locked_out` — clearing a lockout that is not set is the machine's "any other pair" (there is
 * nothing to clear, and the UI offers the action only for a locked user).
 *
 * @throws {DomainError} `INVALID_TRANSITION` unless the row is `locked_out`.
 */
export function clearLockout(
  row: PinAttemptRow | null,
  userId: string,
  deviceId: string,
): PinAttemptRow {
  if (derivePinAuthState(row) !== 'locked_out') {
    throw invalidTransition(derivePinAuthState(row), 'clear_lockout');
  }
  return clearedRow(userId, deviceId);
}

/**
 * PIN-reset side effect (03 §9.2: `locked_out / any → unlocked`): a newer-`asOf` verifier clears the
 * counter from ANY state. This is the auth runtime's touch of `pin_attempt_state`, not a projection
 * applier (03 §9.2 — appliers stay pure). Always valid.
 */
export function resetForNewVerifier(userId: string, deviceId: string): PinAttemptRow {
  return clearedRow(userId, deviceId);
}

function invalidTransition(from: PinAuthState, event: string): DomainError {
  return new DomainError(
    'INVALID_TRANSITION',
    { machine: 'PinAuth', from, event },
    `PinAuth: ${event} is not valid from ${from} (03-state-machines §9.2)`,
  );
}
