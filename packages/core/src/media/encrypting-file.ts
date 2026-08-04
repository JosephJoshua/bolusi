// TASK 158 — the platform-free encrypt/decrypt layer that sits between the media pipeline and the raw
// filesystem, so captured media FILES are AES-256-GCM ciphertext at rest (the file counterpart to the
// column encryption of task 148). It applies `MediaFileCipher` (framed AEAD, `crypto/media-file-cipher`)
// over a thin RAW byte-IO seam a native adapter provides — `apps/mobile/src/media/files.ts` binds that
// seam to expo-file-system `FileHandle`. Keeping the streaming loops here (not in the native file) is
// what lets the whole property be tested in Node against an in-memory raw store: raw bytes are
// ciphertext, `readChunk`/`hashFile`/`sizeOf` return PLAINTEXT, and a wrong key or tampered byte fails
// LOUD (SEC-MEDIA-09).
//
// Peak memory is one frame on every path — encrypt reads one plaintext frame, seals, writes; decrypt
// reads one on-disk frame, opens, yields — never the whole file (06 §5.5, the 2 GB-device budget).
import {
  MediaFileCipher,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_ON_DISK_FRAME_BYTES,
  onDiskFrameLength,
  onDiskFrameOffset,
  plaintextSizeFromOnDisk,
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

/** Injected SHA-256: lowercase hex over `plaintext`. Device binds quick-crypto; tests bind node:crypto. */
export type Sha256Hex = (plaintext: Uint8Array) => string;

/**
 * The encrypt/decrypt layer. Bind it once with the media-file cipher, the native raw IO, and a sha256,
 * and it presents plaintext-facing file operations to the pipeline while the bytes on disk stay
 * ciphertext.
 */
export class EncryptingMediaFile {
  readonly #cipher: MediaFileCipher;
  readonly #io: RawMediaFileIo;
  readonly #sha256Hex: Sha256Hex;

  constructor(cipher: MediaFileCipher, io: RawMediaFileIo, sha256Hex: Sha256Hex) {
    this.#cipher = cipher;
    this.#io = io;
    this.#sha256Hex = sha256Hex;
  }

  /**
   * Encrypt `plaintext` into a fresh file at `path`, one 256 KiB frame at a time. An empty buffer
   * writes an empty file (0 frames) — `plaintextSizeFromOnDisk(0) === 0` reads it back consistently.
   */
  async encryptToFile(path: string, plaintext: Uint8Array): Promise<void> {
    const handle = await this.#io.openWrite(path);
    try {
      for (let offset = 0; offset < plaintext.byteLength; offset += MEDIA_FILE_FRAME_BYTES) {
        const end = Math.min(offset + MEDIA_FILE_FRAME_BYTES, plaintext.byteLength);
        await handle.write(this.#cipher.sealFrame(plaintext.subarray(offset, end)));
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Re-encrypt the plaintext file at `sourcePlaintextPath` into `destPath`, frame-by-frame, then
   * delete the source. This is the encrypting form of the cache→document-dir move (06 §2.2 step 5):
   * the source is the plaintext capture scratch, the destination is the at-rest evidence file. The
   * source is read through the RAW seam because at this seam it has not been encrypted yet — the ONLY
   * place a plaintext file legitimately exists on disk, and it is removed here.
   */
  async encryptPlaintextFileTo(sourcePlaintextPath: string, destPath: string): Promise<void> {
    const total = await this.#io.size(sourcePlaintextPath);
    const reader = await this.#io.openRead(sourcePlaintextPath);
    const writer = await this.#io.openWrite(destPath);
    try {
      for (let offset = 0; offset < total; offset += MEDIA_FILE_FRAME_BYTES) {
        const length = Math.min(MEDIA_FILE_FRAME_BYTES, total - offset);
        const frame = await reader.read(offset, length);
        await writer.write(this.#cipher.sealFrame(frame));
      }
    } finally {
      await reader.close();
      await writer.close();
    }
    await this.#io.delete(sourcePlaintextPath);
  }

  /**
   * Plaintext chunk `[offset, offset+length)`. `offset` MUST be a multiple of the frame size (it is:
   * the drain reads at `chunkIndex * chunkSize`, and the frame size is pinned equal to the wire chunk
   * size). Reads exactly one on-disk frame and opens it — never the rest of the file.
   */
  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset % MEDIA_FILE_FRAME_BYTES !== 0) {
      throw new RangeError(`readChunk offset ${offset} is not a frame boundary`);
    }
    const frameIndex = offset / MEDIA_FILE_FRAME_BYTES;
    const handle = await this.#io.openRead(path);
    try {
      const frame = await handle.read(onDiskFrameOffset(frameIndex), onDiskFrameLength(length));
      return this.#cipher.openFrame(frame);
    } finally {
      await handle.close();
    }
  }

  /** Lowercase hex SHA-256 over the PLAINTEXT — decrypts frame-by-frame, hashes the plaintext. */
  async hashFile(path: string): Promise<string> {
    const plaintext = await this.#decryptWhole(path);
    return this.#sha256Hex(plaintext);
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
   * Decrypt the whole file into one plaintext buffer. Used by `hashFile` and by the render path (which
   * writes the result to a transient plaintext temp the OS image loader can read). Streams the READ —
   * peak read memory is one on-disk frame — but returns the whole plaintext, which for a v0 photo is
   * ≤ 300 KiB; a v1 video render would stream to the temp file instead of buffering (06 §7 tripwire).
   */
  async decryptToBuffer(path: string): Promise<Uint8Array> {
    return this.#decryptWhole(path);
  }

  async #decryptWhole(path: string): Promise<Uint8Array> {
    const onDiskSize = await this.#io.size(path);
    const plaintextSize = plaintextSizeFromOnDisk(onDiskSize);
    const out = new Uint8Array(plaintextSize);
    const handle = await this.#io.openRead(path);
    try {
      let onDiskOffset = 0;
      let plaintextOffset = 0;
      while (onDiskOffset < onDiskSize) {
        const frameOnDisk = Math.min(MEDIA_FILE_ON_DISK_FRAME_BYTES, onDiskSize - onDiskOffset);
        const frame = await handle.read(onDiskOffset, frameOnDisk);
        const chunk = this.#cipher.openFrame(frame);
        out.set(chunk, plaintextOffset);
        onDiskOffset += frameOnDisk;
        plaintextOffset += chunk.byteLength;
      }
      if (plaintextOffset !== plaintextSize) {
        throw new Error(`decrypt recovered ${plaintextOffset} bytes, expected ${plaintextSize}`);
      }
    } finally {
      await handle.close();
    }
    return out;
  }
}
