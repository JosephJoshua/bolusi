// TASK 158 — file-level AEAD for captured media at rest (06-media-pipeline §7; the file counterpart
// to the column encryption task 148 shipped for the DB). Captured repair photos live as FILES under
// `<documentDirectory>/media/` and the render cache under `<cacheDirectory>/media/`; the DB only holds
// a `local_path` pointer, so column encryption leaves the photo — the actual evidence — as plaintext
// on disk. A forensic reader of a lost, powered-off device reads the JPEG directly. This closes that.
//
// FRAMED **STREAM** CONSTRUCTION — bound as an ordered file, not just per-frame (review 2026-08-04).
// The on-disk file is a random per-file nonce base followed by a sequence of AEAD frames:
//
//     file  = base(8) ‖ frame[0] ‖ frame[1] ‖ … ‖ frame[n-1]
//     frame = ciphertext(len) ‖ tag(16)                         (len ≤ 256 KiB; NO per-frame nonce)
//     nonce[i] = base(8) ‖ BE32( i + (isLast ? 2^31 : 0) )      (derived, never stored)
//
// The nonce being DERIVED from (base, frame index, final-frame flag) — not read from the frame — is
// what makes the file tamper-evident as a WHOLE, closing the gap a naive `random-nonce‖ct‖tag` framing
// leaves open: reordering frames, truncating whole frames at a boundary, duplicating a frame, or
// splicing a frame in from another media file (all files share one derived key) each decrypt under the
// WRONG derived nonce and fail the GCM tag — they throw, never returning rearranged plaintext. The
// random base per file is what prevents `(key, nonce)` reuse across files at the same index (which,
// under a shared key, would be catastrophic). The FINAL-frame flag on the last frame is what makes a
// whole-frame truncation fail: the new last frame was sealed WITHOUT the flag, so opening it as the
// last frame fails. (A truncation to header-only — every frame removed — yields 0 plaintext, caught by
// the signed `mediaRef.sizeBytes`/`sha256`, not by a frame flag: there is no frame left to flag.)
//
// The frame plaintext size is pinned EQUAL to the api/03-media §4 wire chunk size (262144), so a
// plaintext byte offset `i * 256 KiB` — how the upload drain and the streamed hash read the file
// (06 §5.5, §2.2 step 6) — maps to on-disk frame `i` with no per-file index (every frame but the last
// is full). WHY NOT ONE AEAD OVER THE WHOLE FILE: the api/03-media §3.1 cap is 10 MiB (v1 video), and a
// single-tag scheme cannot verify a chunk without buffering the whole ciphertext — the 2 GB-device
// memory failure 06 §5.5 avoids. Framing keeps peak memory at one frame on encrypt and decrypt.
//
// KEY (task 158 decision): a SIBLING of the SecureStore DB root key (`bolusi.db_encryption_key`, task
// 50 / 148), derived by domain-separated HMAC — the same construction the column cipher uses for its
// marker subkey — reusing the one already-linked AEAD primitive. Key separation by purpose: a leak of
// the media-file key is not the DB-column key and vice versa, and no second secret is stored.
//
// PLATFORM-FREE: Uint8Array in/out, the AEAD injected as `MediaFileAead` (structural — the device
// `deviceColumnAead` and the test `nodeColumnAead` both satisfy it). NOT on the `AT_REST_SURFACE`
// provenance list yet: anchoring the new media-file surface to an emulator artifact is deferred (D21,
// the SEC-AUTH-09 posture), so the mechanism is proven by the adversarial unit tests here.
import { utf8ToBytes } from './bytes.js';

/**
 * The slice of the app-layer AEAD this cipher needs. Structural on purpose: `deviceColumnAead`
 * (react-native-quick-crypto) and `nodeColumnAead` (`node:crypto`) — both `AeadCipher` from
 * `@bolusi/db-client` — satisfy it without `@bolusi/core` importing `@bolusi/db-client` (which would
 * be a dependency cycle: db-client depends on core, never the reverse).
 */
export interface MediaFileAead {
  /** AES-256-GCM. Returns `ciphertext ‖ authTag(16)`. Key 32 bytes, nonce 12 bytes. */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Splits the trailing 16-byte tag and verifies it. THROWS on a wrong key or any tamper. */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array;
  randomBytes(length: number): Uint8Array;
  /** HMAC-SHA256 — used ONLY to derive the sibling key, never to authenticate frame data. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
}

/** Plaintext bytes per frame — PINNED equal to the api/03-media §4 wire chunk size (256 KiB). */
export const MEDIA_FILE_FRAME_BYTES = 262_144;
/** AES-GCM nonce length (bytes) — the DERIVED nonce, never stored on disk. */
export const MEDIA_FILE_NONCE_BYTES = 12;
/** AES-GCM tag length (bytes) — the trailing tag `seal` appends and `open` verifies. */
export const MEDIA_FILE_TAG_BYTES = 16;
/** Random per-file nonce base, written once as the file header. `base ‖ BE32(counter)` = the nonce. */
export const MEDIA_FILE_NONCE_BASE_BYTES = 8;
/** The file header: the nonce base and nothing else. */
export const MEDIA_FILE_HEADER_BYTES = MEDIA_FILE_NONCE_BASE_BYTES;
/** Per-frame on-disk overhead: ONLY the appended tag (the nonce is derived, not stored). */
export const MEDIA_FILE_FRAME_OVERHEAD = MEDIA_FILE_TAG_BYTES;
/** On-disk bytes of a FULL frame: a full 256 KiB plaintext plus the tag. */
export const MEDIA_FILE_ON_DISK_FRAME_BYTES = MEDIA_FILE_FRAME_BYTES + MEDIA_FILE_FRAME_OVERHEAD;
/** Required key length (AES-256). */
export const MEDIA_FILE_KEY_BYTES = 32;
/** The final-frame flag, OR-ed into the 32-bit frame counter. Caps the index at 2^31−1 frames. */
const FINAL_FRAME_FLAG = 0x8000_0000;
const MAX_FRAME_INDEX = 0x7fff_ffff;

// Domain-separation label — versioned so a future scheme change is a new label, never a silent re-key
// of existing files. Must never collide with the column cipher's marker labels.
const MEDIA_FILE_KEY_LABEL = 'bolusi/media-file-cipher/key/v1';

/**
 * Derive the media-file key: a domain-separated sibling of the 32-byte DB root key. HMAC-SHA256 with a
 * fixed label yields a 32-byte key that reveals nothing about the root and is independent of the
 * column-cipher marker subkey (a different label). The root is the raw SecureStore DB key bytes
 * (`hexToBytes` of `bolusi.db_encryption_key`); this never touches the PIN (D8).
 */
export function deriveMediaFileKey(aead: MediaFileAead, dbRootKey: Uint8Array): Uint8Array {
  if (dbRootKey.byteLength !== MEDIA_FILE_KEY_BYTES) {
    throw new RangeError(
      `media-file root key must be ${MEDIA_FILE_KEY_BYTES} bytes, got ${dbRootKey.byteLength}`,
    );
  }
  return aead.hmacSha256(dbRootKey, utf8ToBytes(MEDIA_FILE_KEY_LABEL));
}

/** On-disk byte offset where frame `frameIndex` begins (after the header; every prior frame full). */
export function onDiskFrameOffset(frameIndex: number): number {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError(`frameIndex must be a non-negative integer, got ${frameIndex}`);
  }
  return MEDIA_FILE_HEADER_BYTES + frameIndex * MEDIA_FILE_ON_DISK_FRAME_BYTES;
}

/** On-disk bytes a frame occupies for a plaintext chunk of `plaintextLength` bytes (tag only). */
export function onDiskFrameLength(plaintextLength: number): number {
  if (!Number.isInteger(plaintextLength) || plaintextLength < 0) {
    throw new RangeError(`plaintextLength must be a non-negative integer, got ${plaintextLength}`);
  }
  if (plaintextLength > MEDIA_FILE_FRAME_BYTES) {
    throw new RangeError(
      `frame plaintext ${plaintextLength} exceeds ${MEDIA_FILE_FRAME_BYTES} — split into frames`,
    );
  }
  return plaintextLength + MEDIA_FILE_TAG_BYTES;
}

/** Number of frames a plaintext of `plaintextSize` bytes occupies (0 for empty). */
export function frameCountFor(plaintextSize: number): number {
  if (!Number.isInteger(plaintextSize) || plaintextSize < 0) {
    throw new RangeError(`plaintextSize must be a non-negative integer, got ${plaintextSize}`);
  }
  return Math.ceil(plaintextSize / MEDIA_FILE_FRAME_BYTES);
}

/**
 * The plaintext size (the SIGNED `mediaRef.sizeBytes`) of an encrypted file whose on-disk size is
 * `onDiskSize`. `onDiskSize = HEADER + 16*n + plaintextSize` with `n = ceil(plaintextSize / 256 KiB)`.
 * Rejects an on-disk size that cannot be a valid header+frame sequence (a truncated file) rather than
 * returning a plausible wrong length — the same fail-closed posture as `hashFile`.
 */
export function plaintextSizeFromOnDisk(onDiskSize: number): number {
  if (!Number.isInteger(onDiskSize) || onDiskSize < 0) {
    throw new RangeError(`onDiskSize must be a non-negative integer, got ${onDiskSize}`);
  }
  if (onDiskSize < MEDIA_FILE_HEADER_BYTES) {
    throw new RangeError(`encrypted file of ${onDiskSize} bytes is smaller than the header`);
  }
  const body = onDiskSize - MEDIA_FILE_HEADER_BYTES;
  if (body === 0) return 0; // header only = empty plaintext
  if (body <= MEDIA_FILE_TAG_BYTES) {
    throw new RangeError(`encrypted body of ${body} bytes is smaller than one empty frame`);
  }
  const frames = Math.ceil(body / MEDIA_FILE_ON_DISK_FRAME_BYTES);
  const plaintextSize = body - MEDIA_FILE_TAG_BYTES * frames;
  const fullFramesPlaintext = (frames - 1) * MEDIA_FILE_FRAME_BYTES;
  if (plaintextSize <= fullFramesPlaintext || plaintextSize > frames * MEDIA_FILE_FRAME_BYTES) {
    throw new RangeError(`on-disk size ${onDiskSize} is not a valid ${frames}-frame sequence`);
  }
  return plaintextSize;
}

/**
 * The framed media-file cipher (STREAM construction). Bind it to the derived key once
 * (`deriveMediaFileKey`) and reuse it. `newNonceBase` mints a per-file base; `sealFrame`/`openFrame`
 * are per-frame keyed on `(base, frameIndex, isLast)` so the file port can stream while the whole file
 * stays bound. `open` throws on a wrong key, a tampered byte, OR a frame decrypted at the wrong
 * position/file (its derived nonce won't match) — it never returns unauthenticated or rearranged bytes.
 */
export class MediaFileCipher {
  readonly #key: Uint8Array;
  readonly #aead: MediaFileAead;

  constructor(key: Uint8Array, aead: MediaFileAead) {
    if (key.byteLength !== MEDIA_FILE_KEY_BYTES) {
      throw new RangeError(
        `media-file key must be ${MEDIA_FILE_KEY_BYTES} bytes, got ${key.byteLength}`,
      );
    }
    this.#key = key;
    this.#aead = aead;
  }

  /** A fresh random per-file nonce base — written as the file header, one per encrypted file. */
  newNonceBase(): Uint8Array {
    return this.#aead.randomBytes(MEDIA_FILE_NONCE_BASE_BYTES);
  }

  /** The derived 12-byte nonce for frame `frameIndex` (final-flagged when `isLast`) under `base`. */
  #nonceFor(base: Uint8Array, frameIndex: number, isLast: boolean): Uint8Array {
    if (base.byteLength !== MEDIA_FILE_NONCE_BASE_BYTES) {
      throw new RangeError(
        `nonce base must be ${MEDIA_FILE_NONCE_BASE_BYTES} bytes, got ${base.byteLength}`,
      );
    }
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > MAX_FRAME_INDEX) {
      throw new RangeError(`frameIndex out of range: ${frameIndex}`);
    }
    const nonce = new Uint8Array(MEDIA_FILE_NONCE_BYTES);
    nonce.set(base, 0);
    const counter = frameIndex + (isLast ? FINAL_FRAME_FLAG : 0);
    new DataView(nonce.buffer).setUint32(MEDIA_FILE_NONCE_BASE_BYTES, counter, false); // big-endian
    return nonce;
  }

  /** Seal one plaintext frame (≤ 256 KiB) → `ciphertext ‖ tag(16)`. Nonce derived, not stored. */
  sealFrame(
    base: Uint8Array,
    frameIndex: number,
    isLast: boolean,
    plaintext: Uint8Array,
  ): Uint8Array {
    if (plaintext.byteLength > MEDIA_FILE_FRAME_BYTES) {
      throw new RangeError(
        `frame plaintext ${plaintext.byteLength} exceeds ${MEDIA_FILE_FRAME_BYTES} bytes`,
      );
    }
    return this.#aead.seal(this.#key, this.#nonceFor(base, frameIndex, isLast), plaintext);
  }

  /** Open one on-disk frame → its plaintext. Throws on a short frame, wrong key, tamper, OR wrong position. */
  openFrame(base: Uint8Array, frameIndex: number, isLast: boolean, frame: Uint8Array): Uint8Array {
    if (frame.byteLength < MEDIA_FILE_TAG_BYTES) {
      throw new RangeError(
        `frame of ${frame.byteLength} bytes is shorter than the ${MEDIA_FILE_TAG_BYTES}-byte tag`,
      );
    }
    return this.#aead.open(this.#key, this.#nonceFor(base, frameIndex, isLast), frame);
  }
}
