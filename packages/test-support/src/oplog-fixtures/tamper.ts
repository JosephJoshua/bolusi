// Tamper transforms over a signed op (task 07 rejection matrix; CHAOS-05; 05 §8).
//
// Each transform changes EXACTLY ONE thing so the resulting rejection is attributable
// (testing-guide T-14b): the op is otherwise structurally valid, and the untampered original
// is the fixture-validity control that must be ACCEPTED. Transforms come in two flavours:
//   - post-hash mutations (payload / core field changed, hash+signature UNTOUCHED) → the
//     server recomputes JCS from the received fields, the recomputed hash ≠ the claimed hash,
//     and the signature check over the recomputed digest fails ⇒ BAD_SIGNATURE.
//   - re-signed mutations (previousHash / seq changed AND re-signed) → the signature is valid
//     over the tampered core, so the op passes the crypto gate and trips the CHAIN check
//     instead ⇒ CHAIN_BROKEN. Attribution is the whole point: a chain test whose op also
//     failed the signature would reject for the wrong reason.
import type { CryptoPort } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { resign, toSignedCore, validHashOf } from './builder.js';

/** Mutate the payload but leave `hash`/`signature` in place ⇒ server recompute mismatch. */
export function mutatePayloadPostHash(op: SignedOperation): SignedOperation {
  return { ...op, payload: { ...op.payload, injected: 'post-hash mutation' } };
}

/** Mutate a signed-core field (here `userId`) leaving `hash`/`signature` in place. */
export function mutateUserIdPostHash(op: SignedOperation, newUserId: string): SignedOperation {
  return { ...op, userId: newUserId };
}

/**
 * Keep the core (and thus a genuine, matching `hash`), but sign that hash with a DIFFERENT
 * key ⇒ the signature does not verify against the enrolled device key (BAD_SIGNATURE), while
 * the hash itself is valid (so the rejection is the signature, not a hash mismatch).
 */
export function forgeSignature(
  op: SignedOperation,
  foreignSecretKey: Uint8Array,
  crypto: CryptoPort,
): SignedOperation {
  const forged = resign(op, foreignSecretKey, crypto);
  // Restore the genuine hash so ONLY the signature is wrong (attributable BAD_SIGNATURE, not a
  // hash mismatch that would also read as BAD_SIGNATURE for a different reason).
  return { ...toSignedCore(op), hash: validHashOf(op, crypto), signature: forged.signature };
}

/**
 * Set `previousHash` to a wrong value AND re-sign, so the op is cryptographically valid over
 * its (broken) core ⇒ passes the signature gate, fails the CHAIN check ⇒ CHAIN_BROKEN.
 */
export function breakPreviousHash(
  op: SignedOperation,
  wrongPreviousHash: string,
  secretKey: Uint8Array,
  crypto: CryptoPort,
): SignedOperation {
  return resign({ ...op, previousHash: wrongPreviousHash }, secretKey, crypto);
}

/** Relabel `deviceId` (post-hash) — a cross-device splice: server recompute ⇒ BAD_SIGNATURE. */
export function relabelDeviceId(op: SignedOperation, newDeviceId: string): SignedOperation {
  return { ...op, deviceId: newDeviceId };
}

/**
 * Mutate ONLY the derived `hash` field, leaving the core and the signature genuine.
 *
 * The class the hash CROSS-CHECK exists for (05 §2.2, security-guide §3.1 "the client-supplied
 * hash field is never used for verification, only cross-checked"). It is NOT caught by the
 * signature — the signature covers the recomputed digest, which is still valid here — so without
 * the cross-check the server would accept an op whose stored `hash` column disagrees with its own
 * content. That poisons the chain for everyone: the next op's `previousHash` links to this hash,
 * and every other device recomputes a different one on pull.
 *
 * Found by mutation-testing the pipeline (scripts/falsify-oplog.mjs): disabling the cross-check
 * left the suite green until this case existed.
 */
export function mutateHashField(op: SignedOperation, wrongHash: string): SignedOperation {
  return { ...op, hash: wrongHash };
}
