// AES-256-GCM at-rest column cipher (security-guide §6.4/§6.5; D22 + addendum 2; 10-db §9).
//
// Implements the platform-free `ColumnCipher` contract (@bolusi/core) with quick-crypto's OpenSSL via
// an injected `AeadCipher`. It is the ONE place the on-disk ciphertext format is defined:
//
//     stored = COLUMN_CIPHER_MARKER ‖ base64( nonce(12) ‖ ciphertext ‖ tag(16) )
//
// ── THE MARKER IS A READ-SIDE HINT ONLY. IT MUST NEVER STEER A WRITE. ───────────────────────────
// Decryption is TRANSPARENT: the read seam (the Kysely plugin) sees result values with no column
// context (raw `sql` and `SELECT *` both hide which column a value came from), so on READ it decrypts
// a value iff the value ITSELF carries the marker. The base64 body is exactly D22's
// `base64(nonce ‖ ct ‖ tag)`; the marker (U+0001 — not U+0000, which would risk C-string truncation
// across JSI) is a self-identification prefix for that read dispatch.
//
// `encrypt` DELIBERATELY DOES NOT LOOK AT ITS INPUT. An earlier revision had an "idempotence guard"
// — `if (this.isCiphertext(plaintext)) return plaintext;` — justified by a comment claiming no
// plaintext column could begin with a C0 control byte. **That comment was false and it was the only
// thing holding the guard up** (CLAUDE.md §2.11: the comment was the guard). `notes.title`/`body` are
// bare `z.string()` and `users_directory.name` is `z.string().min(1).max(64)`; there is no
// control-character validation anywhere in this repo. So an attacker on a second enrolled device —
// the insider case that is explicitly IN the threat model — could put the marker plus any
// base64-legal text in a note body, and the guard would store that PII **verbatim, in the clear**,
// and then throw on every subsequent read of the table (one poisoned row bricking the switcher).
// Confidentiality loss AND a permanent DoS, from one line of shape-sniffing.
//
// The rule that replaces it: **sealing is unconditional.** Nothing an attacker can put in a value
// can route it away from the cipher. Double-sealing is not a real hazard to defend against — the
// plugin transforms each query's AST once from source, `encryptColumnValue` is called once per value
// at its call site, and no production path ever reads a raw cell and writes it back — so there is
// nothing to trade the vulnerability for.
//
// RESIDUAL, ACCEPTED AND LOUD (read side): a value in a PLAINTEXT-by-design column that begins with
// the marker and decodes as a well-formed blob (e.g. an attacker-supplied `notes.media_mime`) will be
// decrypt-attempted on read and will THROW. That is a denial of service, never a disclosure, and it
// is loud. Restricting the read to the encrypted column NAMES was considered and REJECTED: result
// keys depend on each query's aliases, so a future `SELECT body AS noteText` would silently return
// CIPHERTEXT to the UI — trading a loud failure for a silent one, which §2.11 forbids.
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
    // UNCONDITIONAL BY CONSTRUCTION — this method never inspects `plaintext`. See the file header:
    // the shape-sniffing "already sealed?" short-circuit that used to live here stored attacker-shaped
    // PII in the clear. A value that merely LOOKS like ciphertext is still plaintext, and is sealed
    // like any other; it round-trips back byte-identical because the read decrypts exactly once.
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
