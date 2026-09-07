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
// 32-byte compressed point as the public key — never a DER/PEM KeyObject. quick-crypto 1.1.6 nominally
// exposes those through `raw-seed` / `raw-public` formats, but that path is BROKEN on this Android
// build: `KeyObjectHandle.initRawSeed` throws "Failed to create key from raw seed" (the emulator lane
// caught it — enrollment keygen is the one crypto step no on-device gate exercised, so nothing proved
// the raw handle before it shipped). So this adapter stays on quick-crypto's OWN internal interchange —
// DER — and converts raw<->DER itself. For Ed25519 that is NOT hand-rolled variable-length ASN.1: the
// key type is single-length, so PKCS8/SPKI is a FIXED 16-/12-byte prefix over the 32 raw bytes (RFC
// 8410 §10) — prepend to import, slice the trailing 32 to export. Those prefixes are byte-verified
// against OpenSSL's own Ed25519 export. Every method below therefore avoids the raw-seed / raw-public
// KeyObjectHandle constructors and exporters, and touches only `init`/`exportKey`/`SignHandle` (DER).
import {
  argon2,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'react-native-quick-crypto';

import type { CryptoPort, Ed25519KeyPair, KdfParams } from '@bolusi/core';

// Fixed RFC 8410 §10 DER framings for Ed25519. The key type is single-length, so these are constants,
// not variable-length ASN.1: a valid PKCS8 private key is this 16-byte prefix + the 32-byte seed, and a
// valid SPKI public key is this 12-byte prefix + the 32-byte point. Verified byte-for-byte against
// OpenSSL's own `export({ format: 'der' })`, so `prepend`/`slice(-32)` round-trip exactly.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Copy a quick-crypto Buffer into a plain Uint8Array — core's surface never sees a Buffer. */
function toBytes(value: { readonly [index: number]: number; readonly length: number }): Uint8Array {
  return Uint8Array.from(value as ArrayLike<number>);
}

/** Frame a raw 32-byte value inside its fixed DER prefix (see the prefix constants). */
function framed(prefix: Uint8Array, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

/** A `PrivateKeyObject` for a raw 32-byte RFC 8032 seed — via DER, never the broken raw-seed handle. */
function privateKeyFromSeed(seed: Uint8Array): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: framed(PKCS8_ED25519_PREFIX, seed),
    format: 'der',
    type: 'pkcs8',
  });
}

/** A `PublicKeyObject` for a raw 32-byte compressed point — via DER, never the broken raw-public handle. */
function publicKeyFromRaw(publicKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: framed(SPKI_ED25519_PREFIX, publicKey),
    format: 'der',
    type: 'spki',
  });
}

/** The raw 32-byte point of a public KeyObject: the trailing 32 bytes of its fixed-length SPKI DER. */
function rawPublicOf(key: ReturnType<typeof createPublicKey>): Uint8Array {
  return toBytes(key.export({ type: 'spki', format: 'der' })).slice(-32);
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
    // RFC 8032: an Ed25519 private key IS a uniform 32-byte seed, so an unseeded keypair is just a
    // seeded one over fresh CSPRNG bytes. The secret we return and store IS that seed (the contract,
    // and what the noble vectors pin); the public key is derived from the DER-framed private key. No
    // step touches the raw-seed handle — see the header for why that handle is off-limits on device.
    const secretKey = seed === undefined ? toBytes(randomBytes(32)) : Uint8Array.from(seed);
    return {
      secretKey,
      publicKey: rawPublicOf(createPublicKey(privateKeyFromSeed(secretKey))),
    };
  },

  ed25519GetPublicKey(secretKey: Uint8Array): Uint8Array {
    return rawPublicOf(createPublicKey(privateKeyFromSeed(secretKey)));
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
