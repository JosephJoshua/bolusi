// PIN verifiers — the crown jewel (api/02-auth §5.3, §6.5; SEC-AUTH-01/06/09).
//
// A verifier is SELF-DESCRIBING: its params travel with it, so verification never guesses (§5.3).
// Three properties live here and are proven before review:
//   - BOUNDS (SEC-AUTH-01): a verifier whose params fall outside api/02-auth §5.3's accepted window
//     is rejected AT CONSTRUCTION — the DoS guard, re-checked on the device even though the server
//     Zod-validated it, because "never reaches a verifying device" must be true on the device too.
//   - MERGE (§5.3): the effective verifier for a user is the one with the greatest canonical `asOf`.
//     A nil-device control-plane write loses to any real op position at equal-or-later timestamp,
//     because the nil UUID sorts below every real deviceId (crypto/order.ts).
//   - CONSTANT-TIME COMPARE (SEC-AUTH-09 precursor): the hash comparison folds every byte and the
//     length, so it leaks neither the first differing position nor the length via timing.
import { base64ToBytes, bytesToBase64 } from '../crypto/bytes.js';
import { compareCanonicalOrder, type CanonicalOrderKey } from '../crypto/order.js';
import type { CryptoPort, KdfParams } from '../crypto/port.js';
import { PIN_KDF_BOUNDS } from './constants.js';

/**
 * A point in canonical order (05 §4). Nil-device (`00000000-…`) + seq 0 marks a control-plane write
 * (api/02-auth §5.2).
 *
 * LOCAL STOPGAP — DELETE in favour of the `@bolusi/schemas` Zod `CanonicalRef` when task 33 lands
 * the shared auth DTOs (they live in `apps/server/src/identity/schemas.ts` today; §14 wants them in
 * `@bolusi/schemas`). Structural typing means the shared type drops in without a call-site change.
 */
export interface CanonicalRef {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly seq: number;
}

/**
 * A PIN verifier as it lives in a bundle and in the client `user_pin_verifiers` directory row
 * (api/02-auth §5.2). Carries NO PIN and no reversible secret — only a salted argon2id hash whose
 * params describe how to reproduce it.
 *
 * LOCAL STOPGAP — DELETE in favour of `@bolusi/schemas`'s `PinVerifier` (task 33). Kept structurally
 * identical to `apps/server/src/identity/schemas.ts`'s `PinVerifierSchema` so the two agree until the
 * shared schema is the single source.
 */
export interface PinVerifier {
  readonly algorithm: 'argon2id';
  /** 16 CSPRNG bytes, base64 — a NEW salt on every set/change/reset (SEC-AUTH-06). */
  readonly saltB64: string;
  /** argon2 memory cost in KiB — `[19456, 65536]` (§5.3). */
  readonly mKiB: number;
  /** argon2 iterations — `[2, 4]`. */
  readonly t: number;
  /** argon2 lanes — fixed at 1. */
  readonly p: 1;
  /** 32 bytes, base64. */
  readonly hashB64: string;
  /** The verifier's canonical position (§5.3 merge rule). */
  readonly asOf: CanonicalRef;
}

/** A verifier failing the api/02-auth §5.3 bounds. Distinct + greppable — never a UI-facing code. */
export class VerifierBoundsError extends Error {
  override readonly name = 'VerifierBoundsError';
  /** Which bound was violated — for the adversarial test's assertion and for diagnostics. */
  readonly violation: string;
  constructor(violation: string) {
    super(
      `PIN verifier rejected: ${violation} (api/02-auth §5.3 bounds — SEC-AUTH-01). A verifier outside these bounds must never reach a verifying device.`,
    );
    this.violation = violation;
  }
}

/**
 * Reject a verifier whose params/salt/hash fall outside the api/02-auth §5.3 window (SEC-AUTH-01).
 *
 * @throws {VerifierBoundsError} naming the first violated bound. Deliberately not silent: an
 *   out-of-bounds verifier that "just doesn't verify" would be indistinguishable from a wrong PIN,
 *   hiding a hostile bundle as a user error.
 */
export function assertVerifierInBounds(verifier: PinVerifier): void {
  if (verifier.algorithm !== 'argon2id') {
    throw new VerifierBoundsError(`algorithm ${JSON.stringify(verifier.algorithm)} !== 'argon2id'`);
  }
  assertKdfParamsInBounds(verifier.mKiB, verifier.t, verifier.p, decodedLength(verifier.saltB64));
  if (decodedLength(verifier.hashB64) !== PIN_KDF_BOUNDS.hashBytes) {
    throw new VerifierBoundsError(
      `hash decodes to ${String(decodedLength(verifier.hashB64))} bytes, not ${PIN_KDF_BOUNDS.hashBytes}`,
    );
  }
}

/**
 * The api/02-auth §5.3 bounds on everything knowable BEFORE the KDF runs (the cost params + the
 * salt). Split out so `buildPinVerifier` can reject a bad profile without first spending ~300 ms
 * deriving a key it is about to throw away — ONE definition of the bounds, two call sites
 * (CLAUDE.md §2.8).
 */
function assertKdfParamsInBounds(mKiB: number, t: number, p: number, saltBytes: number): void {
  if (
    !Number.isInteger(mKiB) ||
    mKiB < PIN_KDF_BOUNDS.memoryCostMin ||
    mKiB > PIN_KDF_BOUNDS.memoryCostMax
  ) {
    throw new VerifierBoundsError(
      `mKiB ${String(mKiB)} outside [${PIN_KDF_BOUNDS.memoryCostMin}, ${PIN_KDF_BOUNDS.memoryCostMax}]`,
    );
  }
  if (!Number.isInteger(t) || t < PIN_KDF_BOUNDS.timeCostMin || t > PIN_KDF_BOUNDS.timeCostMax) {
    throw new VerifierBoundsError(
      `t ${String(t)} outside [${PIN_KDF_BOUNDS.timeCostMin}, ${PIN_KDF_BOUNDS.timeCostMax}]`,
    );
  }
  if (p !== PIN_KDF_BOUNDS.parallelism) {
    throw new VerifierBoundsError(`p ${String(p)} !== ${PIN_KDF_BOUNDS.parallelism}`);
  }
  if (saltBytes !== PIN_KDF_BOUNDS.saltBytes) {
    throw new VerifierBoundsError(
      `salt decodes to ${String(saltBytes)} bytes, not ${PIN_KDF_BOUNDS.saltBytes}`,
    );
  }
}

/** Byte length of a base64 string, or NaN when it is not valid base64. */
function decodedLength(b64: string): number {
  try {
    return base64ToBytes(b64).length;
  } catch {
    return Number.NaN;
  }
}

/**
 * The `KdfParams` a verifier's params reproduce (api/02-auth §5.3). `outputLength` is fixed at the
 * 32-byte hash size — the verifier's `hashB64` is what it must reproduce, so guessing a different
 * length would silently never match.
 */
export function kdfParamsFor(verifier: PinVerifier): KdfParams {
  return {
    memoryCost: verifier.mKiB,
    timeCost: verifier.t,
    parallelism: verifier.p,
    outputLength: PIN_KDF_BOUNDS.hashBytes,
  };
}

/**
 * Constant-time byte comparison (SEC-AUTH-09; quick-crypto `timingSafeEqual`-equivalent).
 *
 * Folds the length difference AND every byte into one accumulator, then compares once at the end:
 * it never short-circuits on the first differing byte and never returns early on a length mismatch,
 * so an attacker learns neither the position of the first wrong byte nor the length from timing.
 * `?? 0` reads past the shorter array as zero — the length term already forces a mismatch, so this
 * only keeps the loop's per-iteration work uniform.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Derive the argon2id hash for `pin` under `verifier`'s params and salt, and constant-time-compare
 * it to the stored hash (api/02-auth §6.1). The KDF is the caller's to gate (lockout.ts): this runs
 * it unconditionally, so it must only be reached once the attempt is permitted.
 *
 * Returns `true` iff the PIN matches. A wrong PIN derives a different key and returns `false` — the
 * key is never "derived" in the sense of unlocking anything.
 */
export async function verifyPinAgainst(
  crypto: CryptoPort,
  verifier: PinVerifier,
  pin: Uint8Array,
): Promise<boolean> {
  const salt = base64ToBytes(verifier.saltB64);
  const expected = base64ToBytes(verifier.hashB64);
  const derived = await crypto.kdf(pin, salt, kdfParamsFor(verifier));
  return timingSafeEqualBytes(derived, expected);
}

/**
 * Build a fresh verifier for `pin` (api/02-auth §6.6 set/change/reset). `salt` MUST be 16 fresh
 * CSPRNG bytes (SEC-AUTH-06 — a new salt every time); `params` default to the §5.3 default but the
 * floor (or any in-bounds profile) may be swapped in (D12). Validates the result against the bounds
 * before returning it, so a mis-parameterized local build fails here, not on a future device.
 */
export async function buildPinVerifier(
  crypto: CryptoPort,
  pin: Uint8Array,
  params: KdfParams,
  salt: Uint8Array,
  asOf: CanonicalRef,
): Promise<PinVerifier> {
  // Bounds BEFORE the KDF: never spend ~300 ms deriving a key for a profile we are about to reject.
  assertKdfParamsInBounds(params.memoryCost, params.timeCost, params.parallelism, salt.length);
  const hash = await crypto.kdf(pin, salt, params);
  const verifier: PinVerifier = {
    algorithm: 'argon2id',
    saltB64: bytesToBase64(salt),
    mKiB: params.memoryCost,
    t: params.timeCost,
    p: 1,
    hashB64: bytesToBase64(hash),
    asOf,
  };
  assertVerifierInBounds(verifier);
  return verifier;
}

/**
 * Compare two verifiers by canonical `asOf` (§5.3). `> 0` ⇒ `a` is newer. Equal triples are
 * impossible by construction — canonical order is total and `seq` is per-device monotonic, so a 0
 * means the same op — which is why "equal triples" needs no tie-break here.
 */
export function compareVerifierAsOf(a: PinVerifier, b: PinVerifier): number {
  return compareCanonicalOrder(a.asOf as CanonicalOrderKey, b.asOf as CanonicalOrderKey);
}

/**
 * The §5.3 merge: the effective verifier is the one with the greater `asOf`. A local row written by
 * a change/reset on this device wins over an older bundle snapshot; a fresher bundle wins over an
 * older local row; the nil-device control-plane `asOf` loses to any real op position at
 * equal-or-later timestamp (nil UUID < every real deviceId, crypto/order.ts).
 */
export function chooseEffectiveVerifier(
  a: PinVerifier | null,
  b: PinVerifier | null,
): PinVerifier | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareVerifierAsOf(a, b) >= 0 ? a : b;
}
