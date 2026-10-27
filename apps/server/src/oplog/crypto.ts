// The server's production CryptoPort (08 §3.3: apps/server binds its own crypto adapter; @bolusi/core
// is provider-free and only declares `CryptoPort`). The push pipeline verifies every pushed signature
// and hashes its JCS through THIS binding.
//
// SHA-256 and Ed25519 go through `node:crypto` (OpenSSL), the same RFC 8032 implementation family the
// phones use (quick-crypto). The pure-JS noble verify cost about 2.2 ms per op on Node against about
// 0.11 ms here, and it ran on the one event-loop thread while the push held its tenant's counter lock,
// so a 500-op backlog stalled every other request on the server for over a second (measured by the
// sync load test, docs/development.md). Keys stay RAW RFC 8032 bytes at this interface; core's fixed
// DER prefixes frame them for OpenSSL. The shared golden vectors pin the result
// (test/oplog/crypto.test.ts). kdf is unused server-side (PIN verification is on-device) and stays
// on noble's argon2id, present only to satisfy the interface.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  sign,
  verify,
} from 'node:crypto';

import { argon2idAsync } from '@noble/hashes/argon2.js';

import {
  frameEd25519Pkcs8,
  frameEd25519Spki,
  pointFromSpkiDer,
  type CryptoPort,
  type Ed25519KeyPair,
  type KdfParams,
} from '@bolusi/core';

/** Node returns Buffers; core's surface speaks plain Uint8Array. */
function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function privateKeyFromSeed(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.from(frameEd25519Pkcs8(seed)),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicPointOf(seed: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ type: 'spki', format: 'der' });
  return pointFromSpkiDer(toBytes(spki));
}

/** A `CryptoPort` backed by `node:crypto` (05 §2–§3; RFC 8032/8785). */
export const serverCryptoPort: CryptoPort = {
  sha256(data: Uint8Array): Uint8Array {
    return toBytes(createHash('sha256').update(data).digest());
  },

  ed25519Keygen(seed?: Uint8Array): Ed25519KeyPair {
    // Copy a passed seed so a later mutation of the caller's buffer cannot change the key.
    const secretKey = seed ? Uint8Array.from(seed) : toBytes(nodeRandomBytes(32));
    return { secretKey, publicKey: publicPointOf(secretKey) };
  },

  ed25519GetPublicKey(secretKey: Uint8Array): Uint8Array {
    return publicPointOf(secretKey);
  },

  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return toBytes(sign(null, message, privateKeyFromSeed(secretKey)));
  },

  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    // The port contract: verify() returns false and never throws. OpenSSL throws on a key that is not
    // a valid point or the wrong length, which the pull/push paths must not distinguish from "invalid".
    try {
      const key = createPublicKey({
        key: Buffer.from(frameEd25519Spki(publicKey)),
        format: 'der',
        type: 'spki',
      });
      return verify(null, message, key, signature);
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
    return toBytes(nodeRandomBytes(length));
  },
};
