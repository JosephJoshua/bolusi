// TASK 158 — adversarial + geometry tests for the framed media-file cipher. The AEAD is the REAL
// `nodeColumnAead` (node:crypto AES-256-GCM), byte-compatible with the device react-native-quick-crypto
// binding under the same key/nonce — so a frame sealed here would open on device and vice versa.
//
// The security property is: a wrong key or ANY tampered byte fails LOUD (throws), never returns silent
// garbage that a caller would render as a photo. Every "throws" case here has a matching positive
// control so the test cannot pass because `open` rejects everything (T-14 / the negative-control
// discipline). The geometry cases lock the plaintext↔on-disk size mapping the port relies on for the
// signed `sizeBytes` and for `readChunk` offsets — a wrong mapping silently corrupts every upload.
import {
  deriveMediaFileKey,
  MediaFileCipher,
  onDiskFrameLength,
  onDiskFrameOffset,
  plaintextSizeFromOnDisk,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_FRAME_OVERHEAD,
  MEDIA_FILE_KEY_BYTES,
  MEDIA_FILE_NONCE_BYTES,
  MEDIA_FILE_ON_DISK_FRAME_BYTES,
} from '@bolusi/core';
import { nodeColumnAead } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

const ROOT_A = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0xa1);
const ROOT_B = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0xb2);

function cipherFor(root: Uint8Array): MediaFileCipher {
  return new MediaFileCipher(deriveMediaFileKey(nodeColumnAead, root), nodeColumnAead);
}

/** A deterministic pseudo-plaintext of `n` bytes (distinct values so a mis-sliced frame is visible). */
function plaintext(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** Encrypt a whole plaintext buffer the way the port streams it: one frame per 256 KiB. */
function sealWholeFile(cipher: MediaFileCipher, pt: Uint8Array): Uint8Array {
  const frames: Uint8Array[] = [];
  for (let off = 0; off < pt.byteLength || off === 0; off += MEDIA_FILE_FRAME_BYTES) {
    if (off > 0 && off >= pt.byteLength) break;
    frames.push(
      cipher.sealFrame(pt.subarray(off, Math.min(off + MEDIA_FILE_FRAME_BYTES, pt.byteLength))),
    );
    if (pt.byteLength === 0) break;
  }
  let total = 0;
  for (const f of frames) total += f.byteLength;
  const file = new Uint8Array(total);
  let cursor = 0;
  for (const f of frames) {
    file.set(f, cursor);
    cursor += f.byteLength;
  }
  return file;
}

describe('media-file cipher — the AEAD primitive is real and non-trivial (T-14)', () => {
  it('nodeColumnAead exposes the whole MediaFileAead slice', () => {
    expect(typeof nodeColumnAead.seal).toBe('function');
    expect(typeof nodeColumnAead.open).toBe('function');
    expect(typeof nodeColumnAead.randomBytes).toBe('function');
    expect(typeof nodeColumnAead.hmacSha256).toBe('function');
  });
});

describe('media-file key derivation is a domain-separated sibling of the DB root', () => {
  it('derives a 32-byte key, deterministic per root', () => {
    const k1 = deriveMediaFileKey(nodeColumnAead, ROOT_A);
    const k2 = deriveMediaFileKey(nodeColumnAead, ROOT_A);
    expect(k1.byteLength).toBe(MEDIA_FILE_KEY_BYTES);
    expect([...k1]).toEqual([...k2]);
  });

  it('is NOT the root key itself (separation) and differs per root', () => {
    const kA = deriveMediaFileKey(nodeColumnAead, ROOT_A);
    const kB = deriveMediaFileKey(nodeColumnAead, ROOT_B);
    expect([...kA]).not.toEqual([...ROOT_A]); // not the raw root
    expect([...kA]).not.toEqual([...kB]); // different roots → different keys
  });

  it('rejects a root of the wrong length (fail loud, never a truncated key)', () => {
    expect(() => deriveMediaFileKey(nodeColumnAead, new Uint8Array(16))).toThrow();
  });
});

describe('frame seal/open round-trips and fails loud on wrong key or tamper', () => {
  it('round-trips plaintext of 1 byte, a mid size, and a full frame', () => {
    const cipher = cipherFor(ROOT_A);
    for (const n of [1, 1000, MEDIA_FILE_FRAME_BYTES]) {
      const pt = plaintext(n);
      const opened = cipher.openFrame(cipher.sealFrame(pt));
      expect([...opened]).toEqual([...pt]);
    }
  });

  it('the sealed frame is NOT the plaintext (ciphertext at rest) and is nonce+overhead longer', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(64);
    // A JPEG's leading bytes are FF D8 FF; stand in for "recognisable magic bytes".
    pt[0] = 0xff;
    pt[1] = 0xd8;
    pt[2] = 0xff;
    const frame = cipher.sealFrame(pt);
    expect(frame.byteLength).toBe(pt.byteLength + MEDIA_FILE_FRAME_OVERHEAD);
    // The ciphertext body (after the 12-byte nonce) must not start with the plaintext magic bytes.
    const body = frame.subarray(MEDIA_FILE_NONCE_BYTES);
    expect([...body.subarray(0, 3)]).not.toEqual([0xff, 0xd8, 0xff]);
  });

  it('a fresh nonce per seal → two seals of the same plaintext differ, both still open', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(200);
    const a = cipher.sealFrame(pt);
    const b = cipher.sealFrame(pt);
    expect([...a]).not.toEqual([...b]); // different nonce → different frame
    expect([...cipher.openFrame(a)]).toEqual([...pt]);
    expect([...cipher.openFrame(b)]).toEqual([...pt]);
  });

  it('the WRONG key throws (never returns silent garbage) — with a positive control', () => {
    const good = cipherFor(ROOT_A);
    const wrong = cipherFor(ROOT_B);
    const frame = good.sealFrame(plaintext(500));
    expect(() => wrong.openFrame(frame)).toThrow(); // wrong key: loud
    expect(good.openFrame(frame).byteLength).toBe(500); // positive control: right key opens
  });

  it('a single flipped byte anywhere in the frame throws (tamper is loud)', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(777);
    for (const pos of [0, MEDIA_FILE_NONCE_BYTES, 400, /* last (tag) */ -1]) {
      const frame = cipher.sealFrame(pt);
      const i = pos < 0 ? frame.byteLength - 1 : pos;
      frame[i] = (frame[i] ?? 0) ^ 0x01;
      expect(() => cipher.openFrame(frame)).toThrow();
    }
    expect(cipher.openFrame(cipher.sealFrame(pt)).byteLength).toBe(777); // positive control
  });

  it('a frame shorter than the overhead throws rather than under-reading', () => {
    const cipher = cipherFor(ROOT_A);
    expect(() => cipher.openFrame(new Uint8Array(MEDIA_FILE_FRAME_OVERHEAD - 1))).toThrow();
  });

  it('rejects a key of the wrong length at construction', () => {
    expect(() => new MediaFileCipher(new Uint8Array(16), nodeColumnAead)).toThrow();
    expect(() => cipher_ok()).not.toThrow();
    function cipher_ok(): MediaFileCipher {
      return new MediaFileCipher(new Uint8Array(MEDIA_FILE_KEY_BYTES), nodeColumnAead);
    }
  });

  it('a frame plaintext larger than one frame is rejected (the port must split first)', () => {
    const cipher = cipherFor(ROOT_A);
    expect(() => cipher.sealFrame(plaintext(MEDIA_FILE_FRAME_BYTES + 1))).toThrow();
  });
});

describe('on-disk geometry maps plaintext offsets/sizes 1:1 (the readChunk + sizeBytes invariant)', () => {
  it('frame offset and length are the pinned constants', () => {
    expect(onDiskFrameOffset(0)).toBe(0);
    expect(onDiskFrameOffset(3)).toBe(3 * MEDIA_FILE_ON_DISK_FRAME_BYTES);
    expect(onDiskFrameLength(MEDIA_FILE_FRAME_BYTES)).toBe(MEDIA_FILE_ON_DISK_FRAME_BYTES);
    expect(onDiskFrameLength(100)).toBe(100 + MEDIA_FILE_FRAME_OVERHEAD);
  });

  it('plaintextSizeFromOnDisk recovers the exact plaintext size for every boundary case', () => {
    const cipher = cipherFor(ROOT_A);
    const sizes = [
      1,
      1000,
      MEDIA_FILE_FRAME_BYTES - 1,
      MEDIA_FILE_FRAME_BYTES, // exact one full frame
      MEDIA_FILE_FRAME_BYTES + 1, // spills into a 1-byte second frame
      2 * MEDIA_FILE_FRAME_BYTES, // exact two full frames
      2 * MEDIA_FILE_FRAME_BYTES + 123,
    ];
    for (const n of sizes) {
      const onDisk = sealWholeFile(cipher, plaintext(n)).byteLength;
      expect(plaintextSizeFromOnDisk(onDisk)).toBe(n);
    }
  });

  it('rejects an on-disk size that is not a valid frame sequence (truncation is loud)', () => {
    expect(() => plaintextSizeFromOnDisk(MEDIA_FILE_FRAME_OVERHEAD)).toThrow(); // empty last frame
    expect(() => plaintextSizeFromOnDisk(-1)).toThrow();
    expect(plaintextSizeFromOnDisk(0)).toBe(0); // an empty file is 0 plaintext, not an error
  });

  it('a full multi-frame file opens frame-by-frame back to the original plaintext', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(2 * MEDIA_FILE_FRAME_BYTES + 4096);
    const file = sealWholeFile(cipher, pt);
    const frames = Math.ceil(pt.byteLength / MEDIA_FILE_FRAME_BYTES);
    const recovered = new Uint8Array(pt.byteLength);
    let ptCursor = 0;
    for (let i = 0; i < frames; i += 1) {
      const onDiskOff = onDiskFrameOffset(i);
      const ptLen = Math.min(MEDIA_FILE_FRAME_BYTES, pt.byteLength - ptCursor);
      const frame = file.subarray(onDiskOff, onDiskOff + onDiskFrameLength(ptLen));
      const chunk = cipher.openFrame(frame);
      recovered.set(chunk, ptCursor);
      ptCursor += chunk.byteLength;
    }
    expect([...recovered]).toEqual([...pt]);
  });
});
