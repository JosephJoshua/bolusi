// The AEAD primitive the at-rest column cipher runs on (security-guide §6.4/§6.5; D22 addendum).
//
// D22 re-homed at-rest encryption onto AES-256-GCM via **quick-crypto's already-linked OpenSSL 3.6.2**
// — the ONLY on-device crypto (D8), so this adds ZERO native deps and no second `libcrypto` (task
// 148's whole point). quick-crypto exposes Node's classic `createCipheriv`/`createDecipheriv` surface
// verbatim (verified against react-native-quick-crypto 1.1.6 docs — GCM, 12-byte IV, getAuthTag /
// setAuthTag), which is byte-identical to `node:crypto`. So this factory is generic over that shared
// surface: `apps/mobile` binds quick-crypto, CI/tests bind `node:crypto`, and the SAME AES-GCM runs
// on both — the same inject pattern `CryptoPort` uses for Ed25519/argon2id.
//
// This file NEVER imports a crypto provider (db-client is bundled for Hermes AND run under Node); the
// provider is passed in, so no `node:crypto` leaks into the device bundle.

/** A single-shot AES-256-GCM primitive. `seal` returns `ciphertext ‖ tag`; `open` verifies + throws. */
export interface AeadCipher {
  /**
   * AES-256-GCM encrypt. Returns `ciphertext ‖ authTag(16)`. `key` is 32 bytes, `nonce` is 12
   * (NIST-recommended GCM IV length). A fresh random nonce per value is the CALLER's job.
   */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /**
   * AES-256-GCM decrypt of a `ciphertext ‖ authTag(16)` blob. **Throws** on a wrong key or any
   * tampering (the tag fails to verify) — it never returns unauthenticated bytes (SEC-DEV-06).
   */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array;
  /** CSPRNG bytes — the per-value nonce source. */
  randomBytes(length: number): Uint8Array;
}

/** GCM's authentication tag length in bytes (the OpenSSL/Node default). */
export const AEAD_TAG_BYTES = 16;

/** The encrypting half of the Node/quick-crypto cipher surface (a narrow slice — no `node:crypto` types). */
interface GcmCipherLike {
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  getAuthTag(): Uint8Array;
}

/** The decrypting half. Split from {@link GcmCipherLike} because both providers type them separately. */
interface GcmDecipherLike {
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  setAuthTag(tag: Uint8Array): void;
}

/** The Node/quick-crypto module slice this factory needs. Satisfied by `node:crypto` and quick-crypto. */
export interface NodeCompatibleCryptoModule {
  createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): GcmCipherLike;
  createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): GcmDecipherLike;
  randomBytes(size: number): Uint8Array;
}

const ALGORITHM = 'aes-256-gcm';

/** Concatenate byte arrays into one `Uint8Array` (avoids `Buffer.concat`, which Hermes lacks). */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Ensure a driver's `Buffer` return is a plain `Uint8Array` view (Buffer IS a Uint8Array, but pin it). */
function asBytes(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * Build an {@link AeadCipher} over a `node:crypto`-shaped module (quick-crypto on device, `node:crypto`
 * in tests). The two are API-identical for the classic cipher surface, so one adapter serves both.
 */
export function createNodeCompatibleAead(crypto: NodeCompatibleCryptoModule): AeadCipher {
  return {
    seal(key, nonce, plaintext) {
      const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
      const body = concatBytes([asBytes(cipher.update(plaintext)), asBytes(cipher.final())]);
      const tag = asBytes(cipher.getAuthTag());
      return concatBytes([body, tag]);
    },
    open(key, nonce, sealed) {
      if (sealed.length < AEAD_TAG_BYTES) {
        throw new RangeError('AEAD blob shorter than the authentication tag');
      }
      const split = sealed.length - AEAD_TAG_BYTES;
      const ciphertext = sealed.subarray(0, split);
      const tag = sealed.subarray(split);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAuthTag(tag);
      // `final()` throws if the tag does not verify — the wrong-key / tamper signal (SEC-DEV-06).
      return concatBytes([asBytes(decipher.update(ciphertext)), asBytes(decipher.final())]);
    },
    randomBytes: (length) => asBytes(crypto.randomBytes(length)),
  };
}
