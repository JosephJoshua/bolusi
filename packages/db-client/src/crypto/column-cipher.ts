// AES-256-GCM at-rest column cipher (security-guide §6.4/§6.5; D22 + addendum 2; 10-db §9).
//
// Implements the platform-free `ColumnCipher` contract (@bolusi/core) with quick-crypto's OpenSSL via
// an injected `AeadCipher`. It is the ONE place the on-disk ciphertext format is defined:
//
//     stored = COLUMN_CIPHER_MARKER ‖ base64( nonce(12) ‖ ciphertext ‖ tag(16) )
//
// ── WHY THE MARKER (and why a control byte) ─────────────────────────────────────────────────────
// Decryption is TRANSPARENT: the read seam (the Kysely plugin) sees result values with no column
// context (raw `sql` and `SELECT *` both hide which column a value came from), so it decrypts a value
// iff the value ITSELF says it is one of ours. The base64 body is exactly D22's `base64(nonce ‖ ct ‖
// tag)`; the marker is a self-identification prefix so the seam never tries to "decrypt" a plaintext
// column. It leads with U+0001 (SOH) deliberately: none of the plaintext columns this DB stores —
// UUIDs, base64 hashes/signatures, JSON, enums, display names, integers-as-text — can begin with a
// C0 control byte, so a plaintext value can never be mistaken for ciphertext. (U+0001, not U+0000:
// a NUL would risk C-string truncation across the JSI boundary.) `isCiphertext` additionally requires
// the body to decode to at least nonce+tag bytes, so even a pathological plaintext that somehow began
// with the marker is rejected structurally rather than fed to `open` — and if one ever did reach
// `open`, GCM would THROW, never silently surface plaintext.
//
// ── ONE KEY, RANDOM NONCE PER VALUE ─────────────────────────────────────────────────────────────
// The key is the existing 32-byte SecureStore DB key (`SecureStoreDbKeyStore`, 10-db §12) — the same
// bytes that fed `open({encryptionKey})` under SQLCipher, now feeding this codec instead (D22). A
// FRESH 96-bit random nonce per encrypt keeps GCM safe under one long-lived key: the value the switch
// away from key-derivation buys us is simplicity; the value a per-value nonce buys us is not reusing
// a (key, nonce) pair, which is the one thing that breaks GCM. Nonce reuse probability is negligible
// for the per-device write volume, and every value is independently sealed so a nonce collision would
// at worst expose two equal-length values' XOR, never the key.
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  utf8ToBytes,
  type ColumnCipher,
} from '@bolusi/core';

import { AEAD_TAG_BYTES, type AeadCipher } from './aead.js';

/** Self-identifying prefix of a sealed value (see file header on the leading control byte). */
export const COLUMN_CIPHER_MARKER = String.fromCharCode(1) + 'gcm1:';

/** GCM nonce length in bytes (NIST-recommended 96 bits). */
export const COLUMN_NONCE_BYTES = 12;

/** Required key length — AES-256 (10-db §12: "random 32 bytes"). */
export const COLUMN_KEY_BYTES = 32;

/** Smallest possible sealed body: nonce + tag, with an empty-string plaintext. */
const MIN_BLOB_BYTES = COLUMN_NONCE_BYTES + AEAD_TAG_BYTES;

/** Thrown when a stored value is not a well-formed column ciphertext this codec produced. */
export class ColumnCipherError extends Error {
  override readonly name = 'ColumnCipherError';
}

export class Aes256GcmColumnCipher implements ColumnCipher {
  readonly #key: Uint8Array;
  readonly #aead: AeadCipher;

  constructor(key: Uint8Array, aead: AeadCipher) {
    if (key.length !== COLUMN_KEY_BYTES) {
      throw new RangeError(
        `column cipher key must be ${COLUMN_KEY_BYTES} bytes, got ${key.length}`,
      );
    }
    this.#key = key;
    this.#aead = aead;
  }

  encrypt(plaintext: string): string {
    // Idempotent: never double-seal. The registry writers hand plaintext, but a re-run of an already
    // sealed value (e.g. a value that round-tripped without decrypt) must not nest a second envelope.
    if (this.isCiphertext(plaintext)) return plaintext;
    const nonce = this.#aead.randomBytes(COLUMN_NONCE_BYTES);
    const sealed = this.#aead.seal(this.#key, nonce, utf8ToBytes(plaintext));
    const blob = new Uint8Array(nonce.length + sealed.length);
    blob.set(nonce, 0);
    blob.set(sealed, nonce.length);
    return COLUMN_CIPHER_MARKER + bytesToBase64(blob);
  }

  decrypt(stored: string): string {
    if (!stored.startsWith(COLUMN_CIPHER_MARKER)) {
      throw new ColumnCipherError('value is not column ciphertext (missing marker)');
    }
    const blob = base64ToBytes(stored.slice(COLUMN_CIPHER_MARKER.length));
    if (blob.length < MIN_BLOB_BYTES) {
      throw new ColumnCipherError('column ciphertext is truncated');
    }
    const nonce = blob.subarray(0, COLUMN_NONCE_BYTES);
    const sealed = blob.subarray(COLUMN_NONCE_BYTES);
    // `open` throws on a wrong key or tamper — that throw is the SEC-DEV-06 signal, propagated as-is.
    return bytesToUtf8(this.#aead.open(this.#key, nonce, sealed));
  }

  isCiphertext(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith(COLUMN_CIPHER_MARKER)) return false;
    try {
      return base64ToBytes(value.slice(COLUMN_CIPHER_MARKER.length)).length >= MIN_BLOB_BYTES;
    } catch {
      // A marker followed by non-base64 is not one of ours — treat as plaintext, do not attempt open.
      return false;
    }
  }
}
