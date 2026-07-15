// Offline PIN verification (api/02-auth §6.1, §6.5) — the switcher's tap-to-in path.
//
// THE SEQUENCE, and its order is the security property:
//   1. gate on `pin_attempt_state` (lockout.ts) — BEFORE the KDF. A delayed/locked attempt throws
//      here, so argon2id never runs during a window (SEC-AUTH-02): the KDF-invocation spy stays flat
//      and there is no timing/battery oracle.
//   2. run argon2id over the effective verifier's own params (verifier.ts) and constant-time-compare.
//   3. record the outcome: success resets the counter; a wrong PIN increments it, opens the next
//      window, and — on the 10th — emits `auth.pin_locked_out` through the runtime (a sanctioned
//      direct append, api/02-auth §6.3).
//
// "Assert the outcome, not the mechanism": a wrong PIN returns `{ ok: false }` and leaves the
// counter advanced — the key was never derived into anything that unlocks, and the state moved
// toward lockout, not away from it.
import { utf8ToBytes } from '../crypto/bytes.js';
import type { ClockPort } from '../runtime/ports.js';
import type { CryptoPort } from '../crypto/port.js';
import { DomainError } from '../errors/domain-error.js';
import {
  assertAttemptAllowed,
  derivePinAuthState,
  recordFailure,
  recordSuccess,
  type PinAuthState,
} from './lockout.js';
import { readPinAttempt, readVerifier, writePinAttempt } from './repo.js';
import { verifyPinAgainst } from './verifier.js';
import type { Kysely } from 'kysely';

/** The `auth.pin_locked_out` emission (api/02-auth §6.2/§6.3), wired to the runtime by the caller. */
export interface LockedOutEmitter {
  emitLockedOut(input: {
    readonly userId: string;
    readonly consecutiveFailures: number;
    readonly windowStartedAt: number;
  }): Promise<void>;
}

/** The result of a permitted PIN attempt (the gate throws before this on a window/lock). */
export type PinVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly state: PinAuthState; readonly lockedOut: boolean };

export interface PinVerifyDeps<DB> {
  readonly db: Kysely<DB>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly deviceId: string;
  readonly emitter: LockedOutEmitter;
}

/**
 * PIN is 6 digits, fixed in v0 (api/02-auth §6.1). Enforced when SETTING a PIN; verification does not
 * reject a wrong-length input (that simply fails the compare) so a malformed guess still burns an
 * attempt rather than short-circuiting the lockout.
 */
export function assertPinFormat(pin: string): void {
  if (!/^[0-9]{6}$/.test(pin)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      { field: 'pin' },
      'PIN must be exactly 6 digits (api/02-auth §6.1)',
    );
  }
}

/**
 * Verify `pin` for `userId` on this device (api/02-auth §6.1/§6.5).
 *
 * @throws {DomainError} `PIN_LOCKED` / `PIN_RATE_LIMITED` when the attempt is gated (no KDF run);
 *   `ENTITY_NOT_FOUND` when the user has no verifier (the caller should route to the first-PIN flow,
 *   §6.6 — this path is not a guessable-PIN outcome).
 */
export async function verifyPin<DB>(
  deps: PinVerifyDeps<DB>,
  input: { readonly userId: string; readonly pin: string },
): Promise<PinVerifyResult> {
  const { db, crypto, deviceId, emitter } = deps;
  const { userId } = input;
  const now = deps.clock.now();

  const row = await readPinAttempt(db, userId, deviceId);
  assertAttemptAllowed(row, now); // step 1 — throws BEFORE the KDF (SEC-AUTH-02)

  const verifier = await readVerifier(db, userId);
  if (verifier === null) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entity: 'pin_verifier', userId },
      'no PIN verifier for this user — route to the first-PIN flow (api/02-auth §6.6)',
    );
  }

  const matched = await verifyPinAgainst(crypto, verifier, utf8ToBytes(input.pin)); // step 2 — the KDF

  if (matched) {
    await writePinAttempt(db, recordSuccess(row, userId, deviceId)); // step 3 — reset the counter
    return { ok: true };
  }

  const { row: next, lockedOut } = recordFailure(row, userId, deviceId, now);
  await writePinAttempt(db, next);
  if (lockedOut) {
    await emitter.emitLockedOut({
      userId,
      consecutiveFailures: next.consecutiveFailures,
      // recordFailure always sets windowStartedAt on a real failure; the ?? is only for the checker.
      windowStartedAt: next.windowStartedAt ?? now,
    });
  }
  return { ok: false, state: derivePinAuthState(next), lockedOut };
}
