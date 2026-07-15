// Signature + hash verification on push (05 §3, §9; security-guide §3.1 "recomputes, never
// trusts"). The server recomputes `hash = SHA-256(JCS(signedCore))` from the RECEIVED fields via
// the shared @bolusi/core canonicalizer and verifies the Ed25519 signature over that recomputed
// 32-byte digest against the device's registered public key. The client-supplied `hash` field is
// never used for verification, only cross-checked — verifying against the claimed hash would
// accept any op whose `hash` was rewritten to match a mutated payload.
//
// The JCS text this produces IS the verbatim `signed_core_jcs` that gets stored (05 §3,
// 10-db §2.1) — it is never reconstructed from typed jsonb columns, whose numeric
// re-serialization can change bytes and fail genuine signatures.
import { base64ToBytes, hashSignedCore } from '@bolusi/core';
import type { CryptoPort } from '@bolusi/core';
import type { SignedCore, SignedOperation } from '@bolusi/schemas';

export type SignatureOutcome = { readonly ok: true; readonly jcs: string } | { readonly ok: false };

/**
 * Verify a pushed op against `publicKey`, returning the verbatim JCS on success. Total and
 * fail-closed: any recompute mismatch (payload/core mutated post-hash), malformed signature
 * encoding, or bad signature → `{ ok: false }`.
 */
export function verifyPushedSignature(
  op: SignedOperation,
  publicKey: Uint8Array,
  crypto: CryptoPort,
): SignatureOutcome {
  const { hash: claimedHash, signature, ...core } = op;

  let digest;
  try {
    digest = hashSignedCore(core as SignedCore, crypto);
  } catch {
    // The core no longer parses as a §2.1 core (a field mutated to an illegal shape).
    return { ok: false };
  }
  if (digest.hashHex !== claimedHash) return { ok: false };

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    return { ok: false };
  }

  try {
    return crypto.verify(signatureBytes, digest.hash, publicKey)
      ? { ok: true, jcs: digest.jcs }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
