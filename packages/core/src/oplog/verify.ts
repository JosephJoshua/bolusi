// Chain + signature verification with PRECISE violation codes (05-operation-log §2.2,
// §3, §4). Used by the append-path tamper tests here and, later, by the pull side / sync
// engine (task 15) and the CHAOS-05 tamper matrix (task 26).
//
// This is the append path's tamper-detection surface: given a device's ops and its public
// key it recomputes every hash (catching any core mutation), verifies every signature
// (catching a forged/swapped signature), and checks the per-device chain (catching a
// wrong `previousHash`, a non-contiguous `seq`, a bad genesis link, and a spliced
// cross-device op). It NEVER throws — it returns a total result, because the same code
// runs against hostile pulled data where an exception is a DoS lever (05 verify contract).
import type { SignedCore, SignedOperation } from '@bolusi/schemas';
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';

import { base64ToBytes } from '../crypto/bytes.js';
import type { CryptoPort } from '../crypto/port.js';
import { hashSignedCore } from '../crypto/signed-core.js';

export type ChainViolationCode =
  /** Recomputed `SHA-256(JCS(core))` ≠ the stored `hash` — any signed-core field mutated. */
  | 'HASH_MISMATCH'
  /** Signature does not verify against the device key over the recomputed digest. */
  | 'BAD_SIGNATURE'
  /** `previousHash` ≠ the prior op's `hash` — a broken/spliced link (05 §4). */
  | 'PREVIOUS_HASH_MISMATCH'
  /** `seq` is not exactly prior `seq + 1` — a gap, repeat, or reorder (05 §4). */
  | 'SEQ_NOT_CONTIGUOUS'
  /** A `seq = 1` op whose `previousHash` is not 64 zeros (05 §2.1 genesis rule). */
  | 'GENESIS_PREVIOUS_HASH'
  /** An op whose `deviceId` differs from the chain's — a cross-device splice (05 §4). */
  | 'DEVICE_MISMATCH';

export interface ChainViolation {
  /** Position in the supplied array. */
  readonly index: number;
  /** The op's claimed `seq` (for message/report legibility). */
  readonly seq: number;
  readonly code: ChainViolationCode;
}

export interface ChainVerifyResult {
  readonly ok: boolean;
  /** Empty iff `ok`. One op may contribute several codes (e.g. a splice trips three). */
  readonly violations: readonly ChainViolation[];
}

/**
 * Verify a single op's hash + signature, returning the precise failure code or `null`.
 * Recomputes the hash from the core (catching mutation) and only then checks the signature
 * over that recomputed digest — checking a signature against the CLAIMED hash would accept
 * any op whose `hash` field was rewritten to match a mutated payload (05 §3, verify §).
 */
export function verifyOpDetailed(
  op: SignedOperation,
  publicKey: Uint8Array,
  crypto: CryptoPort,
): 'HASH_MISMATCH' | 'BAD_SIGNATURE' | null {
  const { hash: claimedHash, signature, ...core } = op;

  let recomputed;
  try {
    recomputed = hashSignedCore(core as SignedCore, crypto);
  } catch {
    // The core no longer parses as a §2.1 core (e.g. a field mutated to an illegal shape).
    return 'HASH_MISMATCH';
  }
  if (recomputed.hashHex !== claimedHash) return 'HASH_MISMATCH';

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    return 'BAD_SIGNATURE';
  }
  try {
    return crypto.verify(signatureBytes, recomputed.hash, publicKey) ? null : 'BAD_SIGNATURE';
  } catch {
    return 'BAD_SIGNATURE';
  }
}

/**
 * Verify a device's chain. `ops` are expected in ascending chain order (as stored/pulled
 * for one device). Returns every violation found — a total, never-throwing scan.
 *
 * The public key is the claimed signer's; a spliced op from another device fails both
 * `DEVICE_MISMATCH` and `BAD_SIGNATURE` (it was signed by a key that is not `publicKey`),
 * which is exactly why one op can yield several codes.
 */
export function verifyChain(
  ops: readonly SignedOperation[],
  publicKey: Uint8Array,
  crypto: CryptoPort,
): ChainVerifyResult {
  const violations: ChainViolation[] = [];
  const chainDeviceId = ops[0]?.deviceId;

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as SignedOperation;
    const record = (code: ChainViolationCode): void => {
      violations.push({ index: i, seq: op.seq, code });
    };

    if (chainDeviceId !== undefined && op.deviceId !== chainDeviceId) {
      record('DEVICE_MISMATCH');
    }

    const opCode = verifyOpDetailed(op, publicKey, crypto);
    if (opCode !== null) record(opCode);

    if (op.seq === 1 && op.previousHash !== GENESIS_PREVIOUS_HASH) {
      record('GENESIS_PREVIOUS_HASH');
    }

    if (i > 0) {
      const prev = ops[i - 1] as SignedOperation;
      if (op.seq !== prev.seq + 1) record('SEQ_NOT_CONTIGUOUS');
      if (op.previousHash !== prev.hash) record('PREVIOUS_HASH_MISMATCH');
    }
  }

  return { ok: violations.length === 0, violations };
}
