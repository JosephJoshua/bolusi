// AES-256-GCM at-rest column cipher (security-guide §6.4/§6.5; D22 + addendum 2; 10-db §9).
//
// Implements the platform-free `ColumnCipher` contract (@bolusi/core) with quick-crypto's OpenSSL via
// an injected `AeadCipher`. It is the ONE place the on-disk ciphertext format is defined:
//
//     stored = <scheme prefix> ‖ base64(HMAC(key,label)[0..9]) ‖ ':' ‖ base64( nonce(12) ‖ ct ‖ tag(16) )
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
// ── THE MARKER IS KEYED, SO IT CANNOT BE FORGED ────────────────────────────────────────────────
// A FIXED marker made the read dispatch attacker-steerable, and the real instance was far worse than
// the display-surface annoyance first documented here. `operations.agent_conversation_id` is
// plaintext by design, rides the SIGNED envelope as an unbounded `z.string().nullable()`, and is
// selected by the projection fold (`OP_COLUMNS` → `readCanonicalPage`). So a second enrolled device
// could sign an op whose conversation id merely LOOKED sealed; the server accepts it, it syncs to
// every device in the store, and the fold throws — permanently breaking `runRebuild` for that module
// on every device, in an APPEND-ONLY table whose row cannot be deleted without breaking the hash
// chain. A latent, unrecoverable brick that fires on the next module-version bump.
//
// So the marker carries a suffix DERIVED FROM THE DATABASE KEY:
//
//     marker = <scheme prefix> ‖ base64(HMAC-SHA256(key, label)[0..9]) ‖ ':'
//
// Read dispatch stays VALUE-BASED — which keeps the `SELECT body AS noteText` hazard closed, since
// restricting decryption to column NAMES would silently hand ciphertext to a caller that aliased a
// column — but an attacker who does not hold this device's key cannot compute the suffix, so nothing
// they can write into a plaintext column is ever routed into `decrypt`. Keys are per-device and never
// synced (§6.4), so an insider on device B cannot compute device A's marker. The tag is a public
// identifier, not a secret: it authenticates nothing, and GCM's own tag still does all the real work.
//
// KEY-DERIVED, NOT PER-CONNECTION-RANDOM, AND THAT IS LOAD-BEARING: the marker must be identical
// every time the same database is reopened, or every row sealed by an earlier run stops being
// recognised as ciphertext. That property is tested explicitly (reopen → existing rows still read).
//
// CONSEQUENCE FOR A FOREIGN-KEY DATABASE, STATED: values sealed under a DIFFERENT key carry a
// different suffix, so they no longer match this cipher's marker and are passed through as opaque
// envelope text instead of throwing. That is a CHANGE from the previous behaviour and it is not a
// disclosure (the bytes stay ciphertext) — but it means the codec no longer detects a restored
// foreign database on its own, which is exactly the boot-probe gap already filed as task 160. The
// right place to catch that is at open, against a stored key tag; it is not this file's job.
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

/**
 * The FIXED part of a sealed value's prefix — scheme + version. Anyone can write these bytes, so it
 * is NOT sufficient to identify our ciphertext; the key-derived suffix appended after it is what
 * makes the full marker unforgeable. Exported for tests that assert "this cell looks sealed" without
 * needing the key. Leads with U+0001 (not U+0000, which would risk C-string truncation across JSI).
 */
export const COLUMN_CIPHER_SCHEME_PREFIX = String.fromCharCode(1) + 'gcm1:';

/** Domain-separation label for the marker derivation — changing it invalidates every stored marker. */
const MARKER_LABEL = 'bolusi/column-cipher/marker/v1';

/**
 * Label for the intermediate subkey, so the AES-256 encryption key is never used DIRECTLY as an HMAC
 * key. Extract-then-expand shaped: `subkey = HMAC(dbKey, subkeyLabel)`, `tag = HMAC(subkey, label)`.
 *
 * WHAT THIS DOES AND DOES NOT BUY, stated precisely because the obvious claim is wrong: it gives
 * clean domain separation between the AEAD key and the marker derivation. It does **NOT** remove the
 * offline verification oracle — the marker is published in every row and is a deterministic function
 * of the key, so ANY derivation lets someone holding a *candidate* key confirm it. What actually
 * makes that harmless is that the key is 32 CSPRNG bytes and **never PIN-derived** (D8): there is no
 * low-entropy guess to confirm. That makes D8's rule load-bearing here for a second reason beyond
 * the one it was written for, which is worth knowing before anyone proposes deriving this key.
 */
const MARKER_SUBKEY_LABEL = 'bolusi/column-cipher/marker-subkey/v1';

/**
 * Bytes of HMAC output kept in the marker. 9 bytes = 72 bits = exactly 12 base64 chars (no padding).
 * This is a forgery barrier, not a secret: an attacker must produce all 72 bits blind, and they get
 * no oracle — a wrong guess is simply treated as plaintext, so there is nothing to iterate against.
 */
const MARKER_TAG_BYTES = 9;

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
  /** Scheme prefix + this key's derived tag. Deterministic in the key, so it survives a reopen. */
  readonly #marker: string;

  constructor(key: Uint8Array, aead: AeadCipher) {
    if (key.length !== COLUMN_KEY_BYTES) {
      throw new RangeError(
        `column cipher key must be ${COLUMN_KEY_BYTES} bytes, got ${key.length}`,
      );
    }
    this.#key = key;
    this.#aead = aead;
    const subkey = aead.hmacSha256(key, utf8ToBytes(MARKER_SUBKEY_LABEL));
    const tag = aead.hmacSha256(subkey, utf8ToBytes(MARKER_LABEL)).subarray(0, MARKER_TAG_BYTES);
    this.#marker = `${COLUMN_CIPHER_SCHEME_PREFIX}${bytesToBase64(tag)}:`;
  }

  /** This database's full marker. Exposed so tests can assert the reopen-stability property. */
  get marker(): string {
    return this.#marker;
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
    return this.#marker + bytesToBase64(blob);
  }

  decrypt(stored: string): string {
    // Requires THIS key's marker, not merely the scheme prefix: a value sealed under a different key
    // is not ours to open, and neither is anything an attacker wrote.
    if (!stored.startsWith(this.#marker)) {
      throw new ColumnCipherError('value is not column ciphertext for this key (marker mismatch)');
    }
    const blob = base64ToBytes(stored.slice(this.#marker.length));
    if (blob.length < MIN_BLOB_BYTES) {
      throw new ColumnCipherError('column ciphertext is truncated');
    }
    const nonce = blob.subarray(0, COLUMN_NONCE_BYTES);
    const sealed = blob.subarray(COLUMN_NONCE_BYTES);
    // `open` throws on a wrong key or tamper — that throw is the SEC-DEV-06 signal, propagated as-is.
    return bytesToUtf8(this.#aead.open(this.#key, nonce, sealed));
  }

  isCiphertext(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith(this.#marker)) return false;
    try {
      return base64ToBytes(value.slice(this.#marker.length)).length >= MIN_BLOB_BYTES;
    } catch {
      // A marker followed by non-base64 is not one of ours — treat as plaintext, do not attempt open.
      return false;
    }
  }
}
