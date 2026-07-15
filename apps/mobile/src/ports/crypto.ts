// The device `CryptoPort` binding — react-native-quick-crypto 1.1.6 (D8: the SOLE on-device crypto
// provider; noble on Hermes is 100x+ too slow, and a pure-JS KDF on device is forbidden outright,
// 08 §2.4/§2.6).
//
// @bolusi/core declares `CryptoPort` and never imports a provider (08 §3.3); this file is the mobile
// binding. `@bolusi/test-support` binds noble for Node/CI against the SAME interface, and the shared
// RFC 8032 / RFC 9106 vectors (`@bolusi/test-support` `ed25519Vectors` / `argon2idVectors`) are what
// prove the two agree in both directions — that vector run happens on-device (testing-guide L6 /
// task 27a), because this module is a JSI native binding and cannot execute under Node.
//
// KEY REPRESENTATION. `CryptoPort` speaks RAW RFC 8032 bytes: a 32-byte seed as the secret and a
// 32-byte compressed point as the public key — never a DER/PEM KeyObject. quick-crypto 1.1.6 exposes
// exactly that through its `raw-seed` / `raw-public` key formats, so this adapter needs no hand-rolled
// ASN.1: `export({ format: 'raw-seed' })` IS the RFC 8032 seed the op envelope signs with (05 §2.2).
import {
  argon2,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'react-native-quick-crypto';

import type { CryptoPort, Ed25519KeyPair, KdfParams } from '@bolusi/core';

const ED25519 = 'ed25519';

/** Copy a quick-crypto Buffer into a plain Uint8Array — core's surface never sees a Buffer. */
function toBytes(value: { readonly [index: number]: number; readonly length: number }): Uint8Array {
  return Uint8Array.from(value as ArrayLike<number>);
}

/** A `PrivateKeyObject` for a raw 32-byte RFC 8032 seed. */
function privateKeyFromSeed(seed: Uint8Array): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: seed, format: 'raw-seed', asymmetricKeyType: ED25519 });
}

/** A `PublicKeyObject` for a raw 32-byte compressed Edwards point. */
function publicKeyFromRaw(publicKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: publicKey, format: 'raw-public', asymmetricKeyType: ED25519 });
}

/**
 * The device `CryptoPort` (08 §3.2). Sync SHA-256/Ed25519 (quick-crypto's OpenSSL path is
 * sub-millisecond, 08 §2.2); `kdf` is the deliberate async exception — argon2id at D8 params targets
 * ~300 ms and must never block the JS thread, so it uses the native **async** `argon2` callback
 * variant (api/02-auth §5.3), never `argon2Sync`.
 */
export const quickCryptoPort: CryptoPort = {
  sha256(data: Uint8Array): Uint8Array {
    return toBytes(createHash('sha256').update(data).digest());
  },

  ed25519Keygen(seed?: Uint8Array): Ed25519KeyPair {
    // With a seed the result is deterministic (RFC 8032): derive the key object from the seed and
    // read both halves back out raw. Without one, let the native RNG mint the pair.
    const privateKey =
      seed === undefined ? generateKeyPairSync(ED25519).privateKey : privateKeyFromSeed(seed);
    return {
      secretKey: toBytes(privateKey.export({ format: 'raw-seed' })),
      publicKey: toBytes(createPublicKey(privateKey).export({ format: 'raw-public' })),
    };
  },

  ed25519GetPublicKey(secretKey: Uint8Array): Uint8Array {
    return toBytes(createPublicKey(privateKeyFromSeed(secretKey)).export({ format: 'raw-public' }));
  },

  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
    // `algorithm` is null for Ed25519 (the curve fixes the hash — RFC 8032 / Node's contract).
    return toBytes(sign(null, message, privateKeyFromSeed(secretKey)));
  },

  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    // The port contract: return false, NEVER throw, on malformed input — callers must not have to
    // tell "invalid signature" apart from "bad key length" (that distinction is a tamper signal, and
    // 05 §8 already has one code for it).
    try {
      return verify(null, message, publicKeyFromRaw(publicKey), signature);
    } catch {
      return false;
    }
  },

  kdf(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
    // Port names (08 §2.2) -> quick-crypto's RFC 9106 `Argon2Params`.
    return new Promise<Uint8Array>((resolve, reject) => {
      argon2(
        'argon2id',
        {
          message: password,
          nonce: salt,
          parallelism: params.parallelism,
          tagLength: params.outputLength,
          memory: params.memoryCost,
          passes: params.timeCost,
          ...(params.secret ? { secret: params.secret } : {}),
          ...(params.associatedData ? { associatedData: params.associatedData } : {}),
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(toBytes(result));
        },
      );
    });
  },

  randomBytes(length: number): Uint8Array {
    return toBytes(randomBytes(length));
  },
};
