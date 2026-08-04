// TASK 158 — the platform-free encrypt/decrypt layer that sits between the media pipeline and the raw
// filesystem, so captured media FILES are AES-256-GCM ciphertext at rest (the file counterpart to the
// column encryption of task 148). It applies `MediaFileCipher` (STREAM-framed AEAD, `crypto/media-file
// -cipher`) over a thin RAW byte-IO seam a native adapter provides — `apps/mobile/src/media/files.ts`
// binds that seam to expo-file-system `FileHandle`. Keeping the streaming loops here (not in the native
// file) is what lets the whole property be tested in Node against an in-memory raw store: raw bytes are
// ciphertext, `readChunk`/`hashFile`/`sizeOf` return PLAINTEXT, and a wrong key, tampered byte, OR
// STRUCTURAL tamper (reordered / truncated / duplicated / spliced frames) fails LOUD (SEC-MEDIA-09).
//
// The file is `base(8) ‖ frame[0] ‖ … ‖ frame[n-1]`; each frame's nonce is DERIVED from the base + its
// index + a final-frame flag (see media-file-cipher.ts), so a frame decrypted at the wrong position or
// from another file fails its GCM tag. This layer reads the base from the header and drives the index +
// isLast on every path.
//
// PEAK MEMORY is one frame on the CHUNK and HASH paths (`readChunk` opens one frame; `hashFile` decrypts
// frame-by-frame into an incremental digest). `decryptToBuffer` — used only by the render path to write
// a transient plaintext temp `<Image>` can decode — returns the WHOLE plaintext; that is bounded by the
// ≤ 300 KiB v0 photo cap, and a v1 video render must stream to the temp instead of buffering (06 §7).
import {
  frameCountFor,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_NONCE_BASE_BYTES,
  onDiskFrameLength,
  onDiskFrameOffset,
  plaintextSizeFromOnDisk,
  type MediaFileCipher,
} from '../crypto/media-file-cipher.js';

/** A random-access read handle over the RAW (encrypted) on-disk bytes. Close releases the native fd. */
export interface RawReadHandle {
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** A sequential write handle over the RAW on-disk bytes. `write` appends at the current position. */
export interface RawWriteHandle {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * The raw byte seam the native adapter provides. Everything here is over the ENCRYPTED on-disk file —
 * no method sees plaintext. `size` is the on-disk (ciphertext) size; the encrypting layer converts it
 * to the plaintext size with `plaintextSizeFromOnDisk`.
 */
export interface RawMediaFileIo {
  size(path: string): Promise<number>;
  openRead(path: string): Promise<RawReadHandle>;
  openWrite(path: string): Promise<RawWriteHandle>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
}

/** An incremental SHA-256 so `hashFile` streams the plaintext frame-by-frame, never buffering it. */
export interface IncrementalSha256 {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

/** Mints an incremental SHA-256. Device binds quick-crypto's `createHash`; tests bind `node:crypto`. */
export type Sha256Factory = () => IncrementalSha256;

/**
 * The encrypt/decrypt layer. Bind it once with the media-file cipher, the native raw IO, and a sha256
 * factory, and it presents plaintext-facing file operations to the pipeline while the bytes on disk
 * stay ciphertext.
 */
export class EncryptingMediaFile {
  readonly #cipher: MediaFileCipher;
  readonly #io: RawMediaFileIo;
  readonly #sha256: Sha256Factory;

  constructor(cipher: MediaFileCipher, io: RawMediaFileIo, sha256: Sha256Factory) {
    this.#cipher = cipher;
    this.#io = io;
    this.#sha256 = sha256;
  }

  /**
   * Encrypt `plaintext` into a fresh file at `path`: a random header base, then one 256 KiB frame at a
   * time with the LAST frame final-flagged. An empty buffer writes just the header (0 frames).
   */
  async encryptToFile(path: string, plaintext: Uint8Array): Promise<void> {
    const base = this.#cipher.newNonceBase();
    const total = frameCountFor(plaintext.byteLength);
    const handle = await this.#io.openWrite(path);
    try {
      await handle.write(base);
      for (let i = 0; i < total; i += 1) {
        const start = i * MEDIA_FILE_FRAME_BYTES;
        const end = Math.min(start + MEDIA_FILE_FRAME_BYTES, plaintext.byteLength);
        await handle.write(
          this.#cipher.sealFrame(base, i, i === total - 1, plaintext.subarray(start, end)),
        );
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Re-encrypt the plaintext file at `sourcePlaintextPath` into `destPath`, frame-by-frame, then delete
   * the source. The encrypting form of the cache→document-dir move (06 §2.2 step 5): the source is the
   * plaintext capture scratch, the destination the at-rest evidence file. The source is read raw — at
   * this seam it is not yet encrypted, the ONLY place a plaintext file legitimately exists on disk, and
   * it is removed here.
   */
  async encryptPlaintextFileTo(sourcePlaintextPath: string, destPath: string): Promise<void> {
    const total = await this.#io.size(sourcePlaintextPath);
    const frames = frameCountFor(total);
    const base = this.#cipher.newNonceBase();
    const reader = await this.#io.openRead(sourcePlaintextPath);
    const writer = await this.#io.openWrite(destPath);
    try {
      await writer.write(base);
      for (let i = 0; i < frames; i += 1) {
        const start = i * MEDIA_FILE_FRAME_BYTES;
        const length = Math.min(MEDIA_FILE_FRAME_BYTES, total - start);
        const chunk = await reader.read(start, length);
        await writer.write(this.#cipher.sealFrame(base, i, i === frames - 1, chunk));
      }
    } finally {
      await reader.close();
      await writer.close();
    }
    await this.#io.delete(sourcePlaintextPath);
  }

  /**
   * Plaintext chunk `[offset, offset+length)`. `offset` MUST be a multiple of the frame size (the drain
   * reads at `chunkIndex * chunkSize`, and the frame size is pinned equal to the wire chunk size). Reads
   * the header base + exactly one on-disk frame and opens it under its derived nonce — never the rest.
   */
  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset % MEDIA_FILE_FRAME_BYTES !== 0) {
      throw new RangeError(`readChunk offset ${offset} is not a frame boundary`);
    }
    const frameIndex = offset / MEDIA_FILE_FRAME_BYTES;
    const totalFrames = frameCountFor(plaintextSizeFromOnDisk(await this.#io.size(path)));
    if (frameIndex >= totalFrames) {
      throw new RangeError(`readChunk frame ${frameIndex} is past the end (${totalFrames} frames)`);
    }
    const handle = await this.#io.openRead(path);
    try {
      const base = await handle.read(0, MEDIA_FILE_NONCE_BASE_BYTES);
      const frame = await handle.read(onDiskFrameOffset(frameIndex), onDiskFrameLength(length));
      return this.#cipher.openFrame(base, frameIndex, frameIndex === totalFrames - 1, frame);
    } finally {
      await handle.close();
    }
  }

  /** Lowercase hex SHA-256 over the PLAINTEXT — decrypts frame-by-frame into an incremental digest. */
  async hashFile(path: string): Promise<string> {
    const hasher = this.#sha256();
    await this.#eachFrame(path, (chunk) => hasher.update(chunk));
    return hasher.digestHex();
  }

  /** The PLAINTEXT size (the signed `mediaRef.sizeBytes`), derived from the on-disk size. */
  async sizeOf(path: string): Promise<number> {
    if (!(await this.#io.exists(path))) throw new Error(`cannot size missing file ${path}`);
    return plaintextSizeFromOnDisk(await this.#io.size(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.#io.exists(path);
  }

  /** Idempotent — a missing file is not an error (pruning, 06 §7). */
  async deleteFile(path: string): Promise<void> {
    if (await this.#io.exists(path)) await this.#io.delete(path);
  }

  /**
   * Decrypt the whole file into one plaintext buffer — used ONLY by the render path (it writes the
   * result to a transient plaintext temp the OS image loader can read). Streams the READ (peak read
   * memory one frame) but returns the whole plaintext, bounded by the ≤ 300 KiB v0 photo cap.
   */
  async decryptToBuffer(path: string): Promise<Uint8Array> {
    const plaintextSize = plaintextSizeFromOnDisk(await this.#io.size(path));
    const out = new Uint8Array(plaintextSize);
    let cursor = 0;
    await this.#eachFrame(path, (chunk) => {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    });
    if (cursor !== plaintextSize) {
      throw new Error(`decrypt recovered ${cursor} bytes, expected ${plaintextSize}`);
    }
    return out;
  }

  /**
   * Open every frame in order, applying `onPlaintext` to each decrypted chunk. Reads the header base
   * once, drives the frame index + final-flag, and opens each on-disk frame under its derived nonce —
   * so a reordered / truncated / duplicated / cross-file-spliced frame throws here.
   */
  async #eachFrame(path: string, onPlaintext: (chunk: Uint8Array) => void): Promise<void> {
    const onDiskSize = await this.#io.size(path);
    const plaintextSize = plaintextSizeFromOnDisk(onDiskSize);
    const totalFrames = frameCountFor(plaintextSize);
    const handle = await this.#io.openRead(path);
    try {
      const base = await handle.read(0, MEDIA_FILE_NONCE_BASE_BYTES);
      for (let i = 0; i < totalFrames; i += 1) {
        const start = i * MEDIA_FILE_FRAME_BYTES;
        const length = Math.min(MEDIA_FILE_FRAME_BYTES, plaintextSize - start);
        const frame = await handle.read(onDiskFrameOffset(i), onDiskFrameLength(length));
        onPlaintext(this.#cipher.openFrame(base, i, i === totalFrames - 1, frame));
      }
    } finally {
      await handle.close();
    }
  }
}
