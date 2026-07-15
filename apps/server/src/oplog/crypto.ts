// The server's production CryptoPort — a thin @noble adapter over the pinned crypto set
// (08 §3.3: "apps/server binds its own thin noble adapter"; the same pins @bolusi/test-support's
// noble-port uses for CI). @bolusi/core is provider-free (it declares `CryptoPort`); the push
// pipeline verifies pushed signatures and hashes JCS through THIS binding.
//
// Only sha256 + verify are on the hot push path; sign/keygen exist so `appendSystemOp` and
// task 17 can drive the same port. kdf is unused server-side (PIN verification is on-device),
// present only to satisfy the interface.
import { ed25519 } from '@noble/curves/ed25519.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import type { CryptoPort, Ed25519KeyPair, KdfParams } from '@bolusi/core';

/** A `CryptoPort` backed by `@noble/curves` + `@noble/hashes` (05 §2–§3; RFC 8032/8785). */
export const serverCryptoPort: CryptoPort = {
  sha256(data: Uint8Array): Uint8Array {
    return sha256(data);
  },

  ed25519Keygen(seed?: Uint8Array): Ed25519KeyPair {
    // noble 2.x may reuse a passed seed buffer; copy so a later mutation cannot change meaning.
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
    // The port contract: verify() returns false and never throws — noble throws on a malformed
    // key/signature length, which the pull/push paths must not have to distinguish from "invalid".
    try {
      return ed25519.verify(signature, message, publicKey);
    } catch {
      return false;
    }
  },

  async kdf(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
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
