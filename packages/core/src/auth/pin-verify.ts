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
import { assertVerifierInBounds, verifyPinAgainst } from './verifier.js';
import type { Kysely } from 'kysely';

// ── the attempt lock (api/02-auth §6.5: "10 consecutive failures", not 10 x callers) ─────────────
//
// THE SEQUENCE BELOW IS A READ-MODIFY-WRITE AND MUST BE ATOMIC. Without this lock, N concurrent
// `verifyPin` calls all read the same `pin_attempt_state` row, all pass the gate, all run the KDF,
// and all write the same incremented counter — last-write-wins. The budget becomes 10 x N. N=2 is an
// ordinary double-tap on a submit button; no attacker is required.
//
// WHY A LOCK AND NOT JUST "RECORD BEFORE THE KDF". Banking the failure before the KDF (which this
// file also does, for crash-safety) shrinks the race window from ~300 ms to one microtask tick — it
// does NOT close it, because the read and the write are still two separate awaits. That was measured,
// not assumed: with the pessimistic order alone, N=20 still evaluated 200 guesses (pin-verify.test.ts
// reproduces it). The counter is only correct if the whole read→gate→record is serialized.
//
// WHY IN-PROCESS SERIALIZATION IS THE RIGHT SHAPE HERE. The client DB is device-local and the app is
// a single process, so every writer of a given `(userId, deviceId)` row is on this event loop. The
// alternatives are worse: a DB transaction would have to nest inside the op-append path's own
// connection-level transaction (the lockout emission opens one), and an atomic SQL `UPDATE … SET
// consecutive_failures = consecutive_failures + 1` would have to re-encode the §6.5 escalation
// schedule in SQL — a second copy of the numbers this module exists to keep in one place
// (CLAUDE.md §2.8, testing-guide §3.6). Serialize, and the machine stays pure TypeScript.
const attemptChains = new Map<string, Promise<unknown>>();

/**
 * The lock key for a `(userId, deviceId)` pair — injective by construction.
 *
 * The delimiter is written as a backslash-u escape, never a raw NUL byte pasted into the source: the same
 * spelling `authz/memo.ts` (task 09) already uses for its memo key. A literal NUL makes the file
 * BINARY to git (`Bin 4469 -> 8758 bytes`) — the diff of a security control becomes unreviewable
 * (§2.9), and any formatter that normalizes control characters can silently mangle the delimiter
 * while every test still passes. The escape keeps the source ASCII and the runtime string identical.
 *
 * WHAT THE DELIMITER ACTUALLY BUYS — stated precisely, because the obvious claim overstates it.
 * Without it, `("ab","c")` and `("a","bc")` map to one key. That does NOT inflate anyone's attempt
 * budget: the counter lives in `pin_attempt_state` under the real composite PK `(user_id,
 * device_id)`, so each pair still reads and writes its own row. What a collision costs is LIVENESS —
 * two unrelated users on a shared terminal would serialize against each other's KDF. Keeping the map
 * injective is what stops that; `assertVerifierInBounds`-style forgery is not on the table here.
 * Exported so that property is asserted by a test rather than assumed (pin-verify.test.ts).
 */
export function attemptLockKey(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}

/** Serialize `fn` against every other in-flight attempt for the same `(userId, deviceId)`. */
function withAttemptLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = attemptChains.get(key) ?? Promise.resolve();
  // Chain on SETTLEMENT, not success: a throwing attempt (PIN_LOCKED, a DB error) must not wedge the
  // queue for this user forever — `prior.then(fn, fn)` runs `fn` either way.
  const result = prior.then(fn, fn);
  // The stored link never rejects, so a failed attempt cannot produce an unhandled rejection when the
  // next caller chains onto it.
  const tail: Promise<unknown> = result.then(
    () => undefined,
    () => undefined,
  );
  attemptChains.set(key, tail);
  void tail.then(() => {
    // Only the tail evicts, so a waiter that chained on after us is never dropped.
    if (attemptChains.get(key) === tail) attemptChains.delete(key);
  });
  return result;
}

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
  const { deviceId } = deps;
  // The whole read→gate→record→KDF→settle sequence is serialized per (userId, deviceId): the counter
  // is a read-modify-write, and §6.5's budget is 10 CONSECUTIVE failures — not 10 per caller.
  return withAttemptLock(attemptLockKey(input.userId, deviceId), () => runAttempt(deps, input));
}

async function runAttempt<DB>(
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

  // Read-side bounds re-check (SEC-AUTH-01, defence in depth). The HOSTILE path is the server bundle,
  // already gated at bundle-apply.ts; this closes the local-DB-write path so a tampered
  // `user_pin_verifiers` row (`mKiB = 1 GiB`, a non-argon2id `algo`, or `p ≠ 1`) can never reach the
  // KDF. Thrown BEFORE the pessimistic bank and the KDF: a corrupt row is not a wrong-PIN attempt, so
  // it neither burns a guess nor spends ~300 ms deriving a key it would throw away.
  assertVerifierInBounds(verifier);

  // PESSIMISTIC: bank the failure BEFORE the KDF, and clear it on success. A process killed mid-KDF
  // (~300 ms of exposure) leaves the attempt COUNTED, never un-counted — the crash fails CLOSED.
  // The optimistic order (count only a confirmed failure) makes kill-during-KDF a free guess.
  const { row: next, lockedOut } = recordFailure(row, userId, deviceId, now);
  await writePinAttempt(db, next);

  const matched = await verifyPinAgainst(crypto, verifier, utf8ToBytes(input.pin)); // step 2 — the KDF

  if (matched) {
    // Reset from the PRE-attempt row, not from `next`: the banked failure may have pushed `next` to
    // `locked_out`, and `recordSuccess` rightly refuses that transition (03 §9.2). `row` passed the
    // gate, so it is unlocked/delayed and the machine's success transition applies to it. This is what
    // makes a CORRECT 10th PIN succeed and reset to 0 rather than lock the user out (§6.5: "a
    // successful verify resets consecutiveFailures to 0").
    await writePinAttempt(db, recordSuccess(row, userId, deviceId)); // step 3 — reset the counter
    return { ok: true };
  }

  // Emit only once the KDF has CONFIRMED the failure. Emitting at the pessimistic write would fire
  // `auth.pin_locked_out` at a user whose 10th PIN turned out to be correct.
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
