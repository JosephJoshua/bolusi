// noble-backed CryptoPort — the reference implementation for Node/CI/harness.
//
// WHY IT LIVES HERE AND NOT IN @bolusi/core: the boundary matrix (08 §3.3) gives noble
// to `test-support`, `harness` and `apps/server` only. `@bolusi/core` is platform-free
// and provider-free — it declares the port (`CryptoPort`) and everyone binds their own:
// this one for Node/CI, quick-crypto for the device (D8 — noble on Hermes is 100x+ too
// slow), a thin server adapter over the same pins in tasks 07/12. The shared LOGIC
// (JCS, hashing, chaining, ordering) lives once in core (CLAUDE.md §2.8); only the
// primitive binding is per-platform.
//
// This file is TEST-ONLY (08 §3.3 rule 6): shipping source never imports it.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { CryptoPort, Ed25519KeyPair, KdfParams } from '@bolusi/core';

/**
 * A `CryptoPort` backed by `@noble/curves` + `@noble/hashes` 2.2.0.
 *
 * RFC 8032-interoperable with react-native-quick-crypto by contract (D8); the shared
 * vector file (`vectors/ed25519.json`) is what proves it in both directions.
 */
export const noblePort: CryptoPort = {
  sha256(data: Uint8Array): Uint8Array {
    return sha256(data);
  },

  ed25519Keygen(seed?: Uint8Array): Ed25519KeyPair {
    // noble 2.x reuses a passed seed buffer rather than copying it, so a later mutation
    // of the caller's array would retroactively change this keypair's meaning. Copy.
    const { secretKey, publicKey } = seed
      ? ed25519.keygen(Uint8Array.from(seed))
      : ed25519.keygen();
    return { secretKey, publicKey };
  },

  ed25519GetPublicKey(secretKey: Uint8Array): Uint8Array {
    return ed25519.getPublicKey(secretKey);
  },

  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return ed25519.sign(message, secretKey);
  },

  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    // The port contract says verify() returns false and never throws: noble throws on a
    // malformed key/signature length, which callers must not have to distinguish from
    // "invalid signature".
    try {
      return ed25519.verify(signature, message, publicKey);
    } catch {
      return false;
    }
  },

  async kdf(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    // Port names (quick-crypto/Node surface, 08 §2.2) -> noble's RFC 9106 names.
    return argon2idAsync(password, salt, {
      m: params.memoryCost,
      t: params.timeCost,
      p: params.parallelism,
      dkLen: params.outputLength,
      ...(params.secret ? { key: params.secret } : {}),
      ...(params.associatedData ? { personalization: params.associatedData } : {}),
    });
  },

  randomBytes(length: number): Uint8Array {
    return randomBytes(length);
  },
};
