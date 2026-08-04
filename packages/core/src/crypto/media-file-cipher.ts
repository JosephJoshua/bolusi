// TASK 158 — file-level AEAD for captured media at rest (06-media-pipeline §7; the file counterpart
// to the column encryption task 148 shipped for the DB). Captured repair photos live as FILES under
// `<documentDirectory>/media/` and the render cache under `<cacheDirectory>/media/`; the DB only
// holds a `local_path` pointer, so column encryption leaves the photo — the actual evidence — as
// plaintext on disk. A forensic reader of a lost, powered-off device reads the JPEG directly. This
// closes that residual.
//
// FRAMED, STREAMED — never the whole file in memory. The on-disk file is a sequence of independent
// AEAD frames, each covering exactly `MEDIA_FILE_FRAME_BYTES` (256 KiB) of plaintext except the last:
//
//     frame = nonce(12) ‖ ciphertext(len) ‖ tag(16)          (len ≤ 256 KiB; tag from AES-256-GCM)
//     file  = frame[0] ‖ frame[1] ‖ … ‖ frame[n-1]
//
// The frame plaintext size is pinned EQUAL to the api/03-media §4 wire chunk size (262144), so a
// plaintext byte offset `i * 256 KiB` — which is exactly how the upload drain and the streamed hash
// read the file (06 §5.5, §2.2 step 6) — maps to on-disk frame `i` with no per-file index: every
// frame but the last is full, so frame `i` begins at `i * MEDIA_FILE_ON_DISK_FRAME_BYTES`. This is
// what lets `MediaFilePort.readChunk` decrypt one 256 KiB chunk without touching the rest of the file.
//
// WHY NOT ONE AEAD OVER THE WHOLE FILE: v0 photos are ≤ 300 KiB, but the api/03-media §3.1 size cap is
// 10 MiB (v1 video), and a single-tag whole-file scheme cannot verify a chunk without buffering the
// whole ciphertext — the exact 2 GB-device memory failure 06 §5.5 exists to avoid. Framing keeps peak
// memory at one frame on both the encrypt and decrypt paths.
//
// KEY (task 158 decision): a SIBLING of the SecureStore DB root key (`bolusi.db_encryption_key`,
// established by task 50 / task 148), derived by domain-separated HMAC — the same construction the
// column cipher already uses for its marker subkey (`column-cipher.ts`), reusing the one already-linked
// AEAD primitive. Key separation by purpose: a leak of the media-file key is not the DB-column key and
// vice versa, and no second secret is stored. `deriveMediaFileKey` is the only sanctioned derivation.
//
// PLATFORM-FREE: Uint8Array in/out, the AEAD injected as `MediaFileAead` (structural — the device
// `deviceColumnAead` over react-native-quick-crypto and the test `nodeColumnAead` over `node:crypto`
// both satisfy it). This file is NOT on the `AT_REST_SURFACE` provenance list yet: anchoring the new
// media-file surface to an emulator artifact is deferred (D21, same posture as the SEC-AUTH-09 column
// leg), so the mechanism is proven here by the adversarial unit tests and the on-device leg follows.
import { concatBytes, utf8ToBytes } from './bytes.js';

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
/** AES-GCM nonce length (bytes). */
export const MEDIA_FILE_NONCE_BYTES = 12;
/** AES-GCM tag length (bytes) — the trailing tag `seal` appends and `open` verifies. */
export const MEDIA_FILE_TAG_BYTES = 16;
/** Per-frame on-disk overhead: the prepended nonce plus the appended tag. */
export const MEDIA_FILE_FRAME_OVERHEAD = MEDIA_FILE_NONCE_BYTES + MEDIA_FILE_TAG_BYTES;
/** On-disk bytes of a FULL frame: a full 256 KiB plaintext plus the overhead. */
export const MEDIA_FILE_ON_DISK_FRAME_BYTES = MEDIA_FILE_FRAME_BYTES + MEDIA_FILE_FRAME_OVERHEAD;
/** Required key length (AES-256). */
export const MEDIA_FILE_KEY_BYTES = 32;

// Domain-separation label — versioned so a future scheme change is a new label, never a silent
// re-key of existing files. Must never collide with the column cipher's marker labels.
const MEDIA_FILE_KEY_LABEL = 'bolusi/media-file-cipher/key/v1';

/**
 * Derive the media-file key: a domain-separated sibling of the 32-byte DB root key. HMAC-SHA256 with
 * a fixed label yields a 32-byte key that reveals nothing about the root and is independent of the
 * column-cipher marker subkey (a different label). The root is the raw SecureStore DB key bytes
 * (`hexToBytes` of `bolusi.db_encryption_key`); this never touches the PIN (D8 — the at-rest key is
 * never PIN-derived).
 */
export function deriveMediaFileKey(aead: MediaFileAead, dbRootKey: Uint8Array): Uint8Array {
  if (dbRootKey.byteLength !== MEDIA_FILE_KEY_BYTES) {
    throw new RangeError(
      `media-file root key must be ${MEDIA_FILE_KEY_BYTES} bytes, got ${dbRootKey.byteLength}`,
    );
  }
  return aead.hmacSha256(dbRootKey, utf8ToBytes(MEDIA_FILE_KEY_LABEL));
}

/** On-disk byte offset where frame `frameIndex` begins. Every frame before the last is full. */
export function onDiskFrameOffset(frameIndex: number): number {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError(`frameIndex must be a non-negative integer, got ${frameIndex}`);
  }
  return frameIndex * MEDIA_FILE_ON_DISK_FRAME_BYTES;
}

/** On-disk bytes a frame occupies for a plaintext chunk of `plaintextLength` bytes. */
export function onDiskFrameLength(plaintextLength: number): number {
  if (!Number.isInteger(plaintextLength) || plaintextLength < 0) {
    throw new RangeError(`plaintextLength must be a non-negative integer, got ${plaintextLength}`);
  }
  if (plaintextLength > MEDIA_FILE_FRAME_BYTES) {
    throw new RangeError(
      `frame plaintext ${plaintextLength} exceeds ${MEDIA_FILE_FRAME_BYTES} — split into frames`,
    );
  }
  return plaintextLength + MEDIA_FILE_FRAME_OVERHEAD;
}

/**
 * The plaintext size (the SIGNED `mediaRef.sizeBytes`) of an encrypted file whose on-disk size is
 * `onDiskSize`. Every frame but the last is full, so `onDiskSize = 28*n + plaintextSize` with
 * `n = ceil(plaintextSize / 256 KiB)`; solving for `n` from the on-disk size gives
 * `n = ceil(onDiskSize / 262172)`, then `plaintextSize = onDiskSize - 28*n`. Rejects an on-disk size
 * that cannot be a valid frame sequence (e.g. a truncated file) rather than returning a plausible
 * wrong length — the same fail-closed posture as `hashFile` (a wrong size would corrupt chunk math).
 */
export function plaintextSizeFromOnDisk(onDiskSize: number): number {
  if (!Number.isInteger(onDiskSize) || onDiskSize < 0) {
    throw new RangeError(`onDiskSize must be a non-negative integer, got ${onDiskSize}`);
  }
  if (onDiskSize === 0) return 0;
  if (onDiskSize <= MEDIA_FILE_FRAME_OVERHEAD) {
    throw new RangeError(`encrypted file of ${onDiskSize} bytes is smaller than one empty frame`);
  }
  const frames = Math.ceil(onDiskSize / MEDIA_FILE_ON_DISK_FRAME_BYTES);
  const plaintextSize = onDiskSize - MEDIA_FILE_FRAME_OVERHEAD * frames;
  // The last frame's plaintext must land in (fullFrames*256KiB, frames*256KiB]; anything else means
  // the on-disk size is not a valid frame sequence.
  const fullFramesPlaintext = (frames - 1) * MEDIA_FILE_FRAME_BYTES;
  if (plaintextSize <= fullFramesPlaintext || plaintextSize > frames * MEDIA_FILE_FRAME_BYTES) {
    throw new RangeError(`on-disk size ${onDiskSize} is not a valid ${frames}-frame sequence`);
  }
  return plaintextSize;
}

/**
 * The framed media-file cipher. Bind it to the derived key once (`deriveMediaFileKey`) and reuse it;
 * `sealFrame`/`openFrame` are per-frame so the file port can stream. `open` throws on a wrong key or
 * any tamper (it never returns unauthenticated bytes), which is the whole security property — a wrong
 * key or a flipped byte fails LOUD, never renders silent garbage.
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

  /** Seal one plaintext frame (≤ 256 KiB) → `nonce(12) ‖ ciphertext ‖ tag(16)`. Fresh nonce per call. */
  sealFrame(plaintext: Uint8Array): Uint8Array {
    if (plaintext.byteLength > MEDIA_FILE_FRAME_BYTES) {
      throw new RangeError(
        `frame plaintext ${plaintext.byteLength} exceeds ${MEDIA_FILE_FRAME_BYTES} bytes`,
      );
    }
    const nonce = this.#aead.randomBytes(MEDIA_FILE_NONCE_BYTES);
    const sealed = this.#aead.seal(this.#key, nonce, plaintext);
    return concatBytes([nonce, sealed]);
  }

  /** Open one on-disk frame → its plaintext. Throws on a short frame, a wrong key, or any tamper. */
  openFrame(frame: Uint8Array): Uint8Array {
    if (frame.byteLength < MEDIA_FILE_FRAME_OVERHEAD) {
      throw new RangeError(
        `frame of ${frame.byteLength} bytes is shorter than the ${MEDIA_FILE_FRAME_OVERHEAD}-byte overhead`,
      );
    }
    const nonce = frame.subarray(0, MEDIA_FILE_NONCE_BYTES);
    const sealed = frame.subarray(MEDIA_FILE_NONCE_BYTES);
    return this.#aead.open(this.#key, nonce, sealed);
  }
}
