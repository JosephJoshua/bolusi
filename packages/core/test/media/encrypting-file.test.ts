// TASK 158 — SEC-MEDIA-09: captured media FILES are AES-256-GCM ciphertext at rest, decrypting
// transparently on every read. This drives the REAL encrypt/decrypt layer (`EncryptingMediaFile`) over
// an in-memory RAW store standing in for expo-file-system, with the REAL node:crypto AES-256-GCM AEAD
// (byte-compatible with the device react-native-quick-crypto binding). What it proves:
//   • a written media file's RAW on-disk bytes are NOT the plaintext (no JPEG magic, no plaintext run);
//   • `sizeOf`/`hashFile`/`readChunk`/`decryptToBuffer` all return PLAINTEXT — the signed sizeBytes and
//     sha256 are preserved, and the upload drain reads the correct plaintext chunk;
//   • a WRONG key or ANY tampered byte fails LOUD (throws) — never silent garbage rendered as a photo.
// Every failure assertion has a positive control (T-14 / negative-control discipline).
//
// The on-device leg (that expo-file-system actually writes these bytes) is emulator-deferred (D21, the
// same posture as the SEC-AUTH-09 column at-rest leg); this proves the mechanism and the port glue.
import { createHash } from 'node:crypto';

import {
  deriveMediaFileKey,
  EncryptingMediaFile,
  MediaFileCipher,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_KEY_BYTES,
  type RawMediaFileIo,
  type RawReadHandle,
  type RawWriteHandle,
} from '@bolusi/core';
import { nodeColumnAead } from '@bolusi/test-support';
import { beforeEach, describe, expect, it } from 'vitest';

const ROOT_A = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0x3c);
const ROOT_B = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0x9e);

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** An in-memory raw byte store — the expo-file-system stand-in. Holds ciphertext exactly as disk would. */
class MemoryRawIo implements RawMediaFileIo {
  readonly files = new Map<string, Uint8Array>();

  async size(path: string): Promise<number> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`no such file ${path}`);
    return f.byteLength;
  }
  async openRead(path: string): Promise<RawReadHandle> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`no such file ${path}`);
    return {
      read: async (offset, length) => f.subarray(offset, offset + length),
      close: async () => {},
    };
  }
  async openWrite(path: string): Promise<RawWriteHandle> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (bytes) => {
        chunks.push(bytes.slice());
      },
      close: async () => {
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const out = new Uint8Array(total);
        let cursor = 0;
        for (const c of chunks) {
          out.set(c, cursor);
          cursor += c.byteLength;
        }
        this.files.set(path, out);
      },
    };
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

function encFor(io: RawMediaFileIo, root: Uint8Array): EncryptingMediaFile {
  const cipher = new MediaFileCipher(deriveMediaFileKey(nodeColumnAead, root), nodeColumnAead);
  return new EncryptingMediaFile(cipher, io, sha256Hex);
}

/** A "JPEG" of `n` bytes: real magic bytes FF D8 FF then a distinct-value body. */
function jpeg(n: number): Uint8Array {
  const out = new Uint8Array(n);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  for (let i = 3; i < n; i += 1) out[i] = (i * 17 + 5) & 0xff;
  return out;
}

let io: MemoryRawIo;
let enc: EncryptingMediaFile;

beforeEach(() => {
  io = new MemoryRawIo();
  enc = encFor(io, ROOT_A);
});

describe('SEC-MEDIA-09 captured media files are ciphertext at rest and decrypt transparently', () => {
  it('the RAW on-disk bytes are NOT the plaintext — no JPEG magic, longer than the plaintext', async () => {
    const photo = jpeg(4211);
    await enc.encryptToFile('doc/a.jpg', photo);
    const onDisk = io.files.get('doc/a.jpg');
    expect(onDisk).toBeDefined();
    // Ciphertext, not the JPEG: no FF D8 FF magic anywhere at the start, and strictly longer (frame
    // overhead). A forensic read of this file yields no image.
    expect([...onDisk!.subarray(0, 3)]).not.toEqual([0xff, 0xd8, 0xff]);
    expect(onDisk!.byteLength).toBeGreaterThan(photo.byteLength);
    expect([...onDisk!]).not.toEqual([...photo]);
  });

  it('sizeOf and hashFile return the PLAINTEXT size and hash (the signed mediaRef is preserved)', async () => {
    const photo = jpeg(4211);
    await enc.encryptToFile('doc/a.jpg', photo);
    expect(await enc.sizeOf('doc/a.jpg')).toBe(photo.byteLength);
    expect(await enc.hashFile('doc/a.jpg')).toBe(sha256Hex(photo));
  });

  it('readChunk returns the exact plaintext chunk the upload drain would send', async () => {
    const photo = jpeg(4211);
    await enc.encryptToFile('doc/a.jpg', photo);
    const chunk = await enc.readChunk('doc/a.jpg', 0, photo.byteLength);
    expect([...chunk]).toEqual([...photo]);
  });

  it('a MULTI-frame file (> 256 KiB) round-trips per frame and by whole-buffer', async () => {
    const big = jpeg(2 * MEDIA_FILE_FRAME_BYTES + 9000);
    await enc.encryptToFile('doc/big.jpg', big);
    expect(await enc.sizeOf('doc/big.jpg')).toBe(big.byteLength);
    expect(await enc.hashFile('doc/big.jpg')).toBe(sha256Hex(big));
    // Read each wire-sized chunk at its frame boundary and reassemble.
    const reassembled = new Uint8Array(big.byteLength);
    let cursor = 0;
    while (cursor < big.byteLength) {
      const len = Math.min(MEDIA_FILE_FRAME_BYTES, big.byteLength - cursor);
      const chunk = await enc.readChunk('doc/big.jpg', cursor, len);
      reassembled.set(chunk, cursor);
      cursor += len;
    }
    expect([...reassembled]).toEqual([...big]);
    expect([...(await enc.decryptToBuffer('doc/big.jpg'))]).toEqual([...big]);
  });

  it('a WRONG key fails LOUD on every read path — with positive controls', async () => {
    const photo = jpeg(4211);
    await enc.encryptToFile('doc/a.jpg', photo);
    const wrong = encFor(io, ROOT_B);
    await expect(wrong.hashFile('doc/a.jpg')).rejects.toThrow();
    await expect(wrong.readChunk('doc/a.jpg', 0, photo.byteLength)).rejects.toThrow();
    await expect(wrong.decryptToBuffer('doc/a.jpg')).rejects.toThrow();
    // Positive controls: the right key reads it fine.
    expect(await enc.hashFile('doc/a.jpg')).toBe(sha256Hex(photo));
    expect((await enc.readChunk('doc/a.jpg', 0, photo.byteLength)).byteLength).toBe(
      photo.byteLength,
    );
  });

  it('a single tampered on-disk byte fails LOUD (authenticated) — with a positive control', async () => {
    const photo = jpeg(4211);
    await enc.encryptToFile('doc/a.jpg', photo);
    const onDisk = io.files.get('doc/a.jpg')!;
    onDisk[20] = (onDisk[20] ?? 0) ^ 0x01;
    await expect(enc.decryptToBuffer('doc/a.jpg')).rejects.toThrow();
    // Positive control: an untouched file still opens.
    await enc.encryptToFile('doc/b.jpg', photo);
    expect(await enc.hashFile('doc/b.jpg')).toBe(sha256Hex(photo));
  });
});

describe('the encrypting cache→document move (06 §2.2 step 5) leaves no plaintext behind', () => {
  it('encrypts the source into the destination as ciphertext and DELETES the plaintext source', async () => {
    const photo = jpeg(4211);
    // The plaintext capture scratch, written raw (as expo would after takePicture/manipulate).
    io.files.set('cache/scratch.jpg', photo);
    await enc.encryptPlaintextFileTo('cache/scratch.jpg', 'doc/a.jpg');
    // Source gone (no lingering plaintext), destination is ciphertext that decrypts to the photo.
    expect(io.files.has('cache/scratch.jpg')).toBe(false);
    const dest = io.files.get('doc/a.jpg')!;
    expect([...dest.subarray(0, 3)]).not.toEqual([0xff, 0xd8, 0xff]);
    expect(await enc.sizeOf('doc/a.jpg')).toBe(photo.byteLength);
    expect(await enc.hashFile('doc/a.jpg')).toBe(sha256Hex(photo));
  });
});

describe('EncryptingMediaFile boundary behaviour', () => {
  it('rejects a readChunk offset that is not a frame boundary (would decode the wrong frame)', async () => {
    await enc.encryptToFile('doc/a.jpg', jpeg(4211));
    await expect(enc.readChunk('doc/a.jpg', 1, 100)).rejects.toThrow();
  });

  it('sizeOf rejects a missing file rather than returning 0', async () => {
    await expect(enc.sizeOf('doc/missing.jpg')).rejects.toThrow();
  });

  it('deleteFile is idempotent (a missing file is not an error)', async () => {
    await enc.encryptToFile('doc/a.jpg', jpeg(64));
    await enc.deleteFile('doc/a.jpg');
    await expect(enc.deleteFile('doc/a.jpg')).resolves.toBeUndefined();
    expect(await enc.exists('doc/a.jpg')).toBe(false);
  });

  it('an empty plaintext writes an empty file and reads back as size 0', async () => {
    await enc.encryptToFile('doc/empty', new Uint8Array(0));
    expect(await enc.sizeOf('doc/empty')).toBe(0);
    expect([...(await enc.decryptToBuffer('doc/empty'))]).toEqual([]);
  });
});
