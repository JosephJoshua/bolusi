// Hash / sign / verify for the signed core (05-operation-log §2.1–2.2, §3).
//
//   hash      = SHA-256( JCS(signedCore) )      -- over exactly the §2.1 field set
//   signature = Ed25519( raw 32-byte hash )     -- NOT over the hex rendering
//
// Signing the raw digest rather than its hex text is load-bearing: the device lane
// (quick-crypto) and the server (noble) must sign/verify identical bytes, and "the
// hex string" is a different 64-byte message than "the 32 bytes".
import { zSignedCore, type SignedCore, type SignedOperation } from '@bolusi/schemas';

import { base64ToBytes, bytesToBase64, bytesToHex, utf8ToBytes } from './bytes.js';
import { canonicalizeJcs, type JsonValue } from './jcs.js';
import type { CryptoPort } from './port.js';

/** The canonical JCS text of a signed core, plus the digest over it. */
export interface SignedCoreDigest {
  /** The exact JCS text that was hashed — persisted verbatim as `signed_core_jcs` (05 §3). */
  jcs: string;
  /** Raw 32-byte SHA-256 digest — what Ed25519 signs. */
  hash: Uint8Array;
  /** Lowercase hex of `hash` — the envelope's `hash` field. */
  hashHex: string;
}

/**
 * Canonicalize + hash a signed core.
 *
 * The input is parsed through `zSignedCore` (strict), which is what makes "exactly the
 * §2.1 field set" true rather than aspirational: `hash`, `signature` and every
 * bookkeeping key (§2.3/§2.4) are unknown keys and therefore REJECTED — they can never
 * silently enter the preimage. An absent nullable key is rejected too (05 §3
 * absent-vs-null), and the JCS guard then rejects any `undefined` inside `payload`.
 *
 * Returns the JCS text alongside the digest because the stores persist it verbatim —
 * re-serializing a core from typed columns can change bytes and fail genuine
 * signatures (05 §3, verbatim-storage rule).
 *
 * @throws {ZodError} if `core` is not exactly a §2.1 signed core.
 * @throws {JcsInputError} if any value cannot be canonicalized.
 */
export function hashSignedCore(core: SignedCore, crypto: CryptoPort): SignedCoreDigest {
  const validated = zSignedCore.parse(core);
  const jcs = canonicalizeJcs(validated as unknown as JsonValue);
  const hash = crypto.sha256(utf8ToBytes(jcs));
  return { jcs, hash, hashHex: bytesToHex(hash) };
}

/**
 * Sign a signed core, producing the derived §2.2 fields.
 *
 * `secretKey` is the device's 32-byte Ed25519 seed.
 */
export function signOp(
  core: SignedCore,
  secretKey: Uint8Array,
  crypto: CryptoPort,
): SignedOperation {
  const { hash, hashHex } = hashSignedCore(core, crypto);
  // The raw digest is the message — never `hashHex`.
  const signature = crypto.sign(hash, secretKey);
  return { ...core, hash: hashHex, signature: bytesToBase64(signature) };
}

/**
 * Verify a signed operation against a device public key.
 *
 * Fail-closed and total: returns `false` for every rejection — a recomputed-hash
 * mismatch (payload mutated post-hash), a malformed signature encoding, or a bad
 * signature. It does not throw, because this runs on the pull path against
 * server-supplied data (api/01-sync §4.2) and an exception there is a denial-of-service
 * lever, not a verification result.
 *
 * Both legs are checked: recomputing the hash catches core mutation, and verifying the
 * signature over that recomputed digest catches a swapped/forged signature. Checking
 * only the signature against the CLAIMED hash would accept any op whose `hash` field
 * was rewritten to match a mutated payload.
 */
export function verifyOp(op: SignedOperation, publicKey: Uint8Array, crypto: CryptoPort): boolean {
  const { hash: claimedHash, signature, ...core } = op;

  let recomputed: SignedCoreDigest;
  try {
    recomputed = hashSignedCore(core as SignedCore, crypto);
  } catch {
    return false;
  }

  if (recomputed.hashHex !== claimedHash) return false;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    return false;
  }

  try {
    return crypto.verify(signatureBytes, recomputed.hash, publicKey);
  } catch {
    return false;
  }
}
