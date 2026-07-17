// Seeded device keypairs — SHA-256(harnessSeed ‖ deviceIndex) → Ed25519 (testing-guide §3.1).
//
// Each virtual device's signing key is derived from the harness seed and its index, so a whole
// N-device run reproduces from one uint32 seed (T-6) and two runs of the same seed sign with
// byte-identical keys (RFC 8032 is deterministic). The 32-byte SHA-256 output IS the RFC 8032
// seed — exactly what `SigningKeyPort.getSigningKey()` returns (core `runtime/ports.ts`) — so
// the derived `seed` drops straight into the production append/sign path with no expansion step.
//
// Uses `noblePort` (the Node/CI CryptoPort binding, §2.2). Device runs bind quick-crypto over
// the SAME pins and reproduce the same keys by the shared ed25519 vectors — the derivation logic
// lives once here (CLAUDE.md §2.8).

import { noblePort } from '../crypto/noble-port.js';

/** A device's deterministic Ed25519 identity. */
export interface DeviceKeypair {
  /** The 32-byte RFC 8032 seed = SHA-256(harnessSeed ‖ deviceIndex). `SigningKeyPort.getSigningKey()`. */
  readonly seed: Uint8Array;
  /** The 32-byte Ed25519 public key registered in the server's device directory. */
  readonly publicKey: Uint8Array;
}

/** Big-endian uint32 — the fixed, cross-platform byte encoding of the two seed inputs. */
function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/**
 * Derive device `deviceIndex`'s keypair under harness seed `harnessSeed`.
 *
 * Deterministic and reproducible: identical `(harnessSeed, deviceIndex)` → identical keys.
 */
export function deriveDeviceKeypair(harnessSeed: number, deviceIndex: number): DeviceKeypair {
  const preimage = new Uint8Array(8);
  preimage.set(u32be(harnessSeed), 0);
  preimage.set(u32be(deviceIndex), 4);
  const seed = noblePort.sha256(preimage);
  const publicKey = noblePort.ed25519GetPublicKey(seed);
  return { seed, publicKey };
}
