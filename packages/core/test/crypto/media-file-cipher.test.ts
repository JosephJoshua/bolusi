// TASK 158 — adversarial + geometry tests for the STREAM-framed media-file cipher. The AEAD is the REAL
// `nodeColumnAead` (node:crypto AES-256-GCM), byte-compatible with the device react-native-quick-crypto
// binding — so a frame sealed here would open on device and vice versa.
//
// The security property: a wrong key, ANY tampered byte, OR a frame opened at the WRONG position (index
// / final-flag / file base) fails LOUD (throws) — never silent or rearranged bytes a caller would
// render as a photo. This is what a naive `random-nonce‖ct‖tag` framing LACKS; here the nonce is derived
// from (base, index, isLast), so position is bound. Every "throws" case has a positive control (T-14).
import {
  deriveMediaFileKey,
  frameCountFor,
  MediaFileCipher,
  onDiskFrameLength,
  onDiskFrameOffset,
  plaintextSizeFromOnDisk,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_HEADER_BYTES,
  MEDIA_FILE_KEY_BYTES,
  MEDIA_FILE_NONCE_BASE_BYTES,
  MEDIA_FILE_ON_DISK_FRAME_BYTES,
  MEDIA_FILE_TAG_BYTES,
} from '@bolusi/core';
import { nodeColumnAead } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

const ROOT_A = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0xa1);
const ROOT_B = new Uint8Array(MEDIA_FILE_KEY_BYTES).fill(0xb2);
const BASE = new Uint8Array(MEDIA_FILE_NONCE_BASE_BYTES).fill(0x5a);

function cipherFor(root: Uint8Array): MediaFileCipher {
  return new MediaFileCipher(deriveMediaFileKey(nodeColumnAead, root), nodeColumnAead);
}

/** A deterministic pseudo-plaintext of `n` bytes (distinct values so a mis-sliced frame is visible). */
function plaintext(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** Encrypt a whole plaintext buffer the way the port streams it: header base, then framed with isLast. */
function sealWholeFile(cipher: MediaFileCipher, pt: Uint8Array, base = BASE): Uint8Array {
  const frames = frameCountFor(pt.byteLength);
  const parts: Uint8Array[] = [base];
  for (let i = 0; i < frames; i += 1) {
    const start = i * MEDIA_FILE_FRAME_BYTES;
    const end = Math.min(start + MEDIA_FILE_FRAME_BYTES, pt.byteLength);
    parts.push(cipher.sealFrame(base, i, i === frames - 1, pt.subarray(start, end)));
  }
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const file = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    file.set(p, cursor);
    cursor += p.byteLength;
  }
  return file;
}

describe('media-file key derivation is a domain-separated sibling of the DB root', () => {
  it('derives a 32-byte key, deterministic per root, differs per root, not the root itself', () => {
    const kA = deriveMediaFileKey(nodeColumnAead, ROOT_A);
    expect(kA.byteLength).toBe(MEDIA_FILE_KEY_BYTES);
    expect([...kA]).toEqual([...deriveMediaFileKey(nodeColumnAead, ROOT_A)]);
    expect([...kA]).not.toEqual([...ROOT_A]);
    expect([...kA]).not.toEqual([...deriveMediaFileKey(nodeColumnAead, ROOT_B)]);
  });

  it('rejects a root of the wrong length (fail loud, never a truncated key)', () => {
    expect(() => deriveMediaFileKey(nodeColumnAead, new Uint8Array(16))).toThrow();
  });
});

describe('frame seal/open round-trips and fails loud on wrong key, tamper, or wrong POSITION', () => {
  it('newNonceBase is 8 random bytes (two mints differ)', () => {
    const cipher = cipherFor(ROOT_A);
    const a = cipher.newNonceBase();
    expect(a.byteLength).toBe(MEDIA_FILE_NONCE_BASE_BYTES);
    expect([...a]).not.toEqual([...cipher.newNonceBase()]);
  });

  it('round-trips at a given (base, index, isLast) for 1 byte, a mid size, and a full frame', () => {
    const cipher = cipherFor(ROOT_A);
    for (const n of [1, 1000, MEDIA_FILE_FRAME_BYTES]) {
      const pt = plaintext(n);
      const frame = cipher.sealFrame(BASE, 2, true, pt);
      expect([...cipher.openFrame(BASE, 2, true, frame)]).toEqual([...pt]);
    }
  });

  it('the sealed frame is NOT the plaintext and carries only a tag (no stored nonce)', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(64);
    pt[0] = 0xff;
    pt[1] = 0xd8;
    pt[2] = 0xff; // JPEG magic
    const frame = cipher.sealFrame(BASE, 0, true, pt);
    expect(frame.byteLength).toBe(pt.byteLength + MEDIA_FILE_TAG_BYTES); // tag only, no nonce
    expect([...frame.subarray(0, 3)]).not.toEqual([0xff, 0xd8, 0xff]);
  });

  it('the WRONG key throws — positive control', () => {
    const good = cipherFor(ROOT_A);
    const wrong = cipherFor(ROOT_B);
    const frame = good.sealFrame(BASE, 0, true, plaintext(500));
    expect(() => wrong.openFrame(BASE, 0, true, frame)).toThrow();
    expect(good.openFrame(BASE, 0, true, frame).byteLength).toBe(500);
  });

  it('a single flipped byte anywhere in the frame throws — positive control', () => {
    const cipher = cipherFor(ROOT_A);
    const pt = plaintext(777);
    for (const pos of [0, 400, /* tag */ -1]) {
      const frame = cipher.sealFrame(BASE, 1, false, pt);
      const i = pos < 0 ? frame.byteLength - 1 : pos;
      frame[i] = (frame[i] ?? 0) ^ 0x01;
      expect(() => cipher.openFrame(BASE, 1, false, frame)).toThrow();
    }
    expect(cipher.openFrame(BASE, 1, false, cipher.sealFrame(BASE, 1, false, pt)).byteLength).toBe(
      777,
    );
  });

  it('opening a frame at the WRONG index throws (position is bound) — positive control', () => {
    const cipher = cipherFor(ROOT_A);
    const frame = cipher.sealFrame(BASE, 3, false, plaintext(500));
    expect(() => cipher.openFrame(BASE, 4, false, frame)).toThrow(); // reorder / shift
    expect(() => cipher.openFrame(BASE, 2, false, frame)).toThrow();
    expect(cipher.openFrame(BASE, 3, false, frame).byteLength).toBe(500);
  });

  it('opening a non-final frame as FINAL (or vice versa) throws (truncation is bound)', () => {
    const cipher = cipherFor(ROOT_A);
    const nonFinal = cipher.sealFrame(BASE, 0, false, plaintext(500));
    expect(() => cipher.openFrame(BASE, 0, true, nonFinal)).toThrow(); // was not the last frame
    const final = cipher.sealFrame(BASE, 0, true, plaintext(500));
    expect(() => cipher.openFrame(BASE, 0, false, final)).toThrow();
  });

  it('opening a frame under a DIFFERENT file base throws (cross-file splice is bound)', () => {
    const cipher = cipherFor(ROOT_A);
    const baseA = new Uint8Array(MEDIA_FILE_NONCE_BASE_BYTES).fill(0x11);
    const baseB = new Uint8Array(MEDIA_FILE_NONCE_BASE_BYTES).fill(0x22);
    const frame = cipher.sealFrame(baseA, 0, true, plaintext(500));
    expect(() => cipher.openFrame(baseB, 0, true, frame)).toThrow();
    expect(cipher.openFrame(baseA, 0, true, frame).byteLength).toBe(500);
  });

  it('rejects a key or base of the wrong length, and an oversized frame plaintext', () => {
    const cipher = cipherFor(ROOT_A);
    expect(() => new MediaFileCipher(new Uint8Array(16), nodeColumnAead)).toThrow();
    expect(() => cipher.sealFrame(new Uint8Array(4), 0, true, plaintext(10))).toThrow(); // bad base
    expect(() => cipher.sealFrame(BASE, 0, true, plaintext(MEDIA_FILE_FRAME_BYTES + 1))).toThrow();
    expect(() =>
      cipher.openFrame(BASE, 0, true, new Uint8Array(MEDIA_FILE_TAG_BYTES - 1)),
    ).toThrow();
  });
});

describe('on-disk geometry maps plaintext offsets/sizes 1:1 (the readChunk + sizeBytes invariant)', () => {
  it('frame offset and length account for the header and tag-only overhead', () => {
    expect(onDiskFrameOffset(0)).toBe(MEDIA_FILE_HEADER_BYTES);
    expect(onDiskFrameOffset(3)).toBe(MEDIA_FILE_HEADER_BYTES + 3 * MEDIA_FILE_ON_DISK_FRAME_BYTES);
    expect(onDiskFrameLength(MEDIA_FILE_FRAME_BYTES)).toBe(MEDIA_FILE_ON_DISK_FRAME_BYTES);
    expect(onDiskFrameLength(100)).toBe(100 + MEDIA_FILE_TAG_BYTES);
  });

  it('plaintextSizeFromOnDisk recovers the exact plaintext size for every boundary case', () => {
    const cipher = cipherFor(ROOT_A);
    const sizes = [
      1,
      1000,
      MEDIA_FILE_FRAME_BYTES - 1,
      MEDIA_FILE_FRAME_BYTES,
      MEDIA_FILE_FRAME_BYTES + 1,
      2 * MEDIA_FILE_FRAME_BYTES,
      2 * MEDIA_FILE_FRAME_BYTES + 123,
    ];
    for (const n of sizes) {
      const onDisk = sealWholeFile(cipher, plaintext(n)).byteLength;
      expect(plaintextSizeFromOnDisk(onDisk)).toBe(n);
    }
  });

  it('an empty file is header-only = 0 plaintext; a sub-header size throws', () => {
    expect(plaintextSizeFromOnDisk(MEDIA_FILE_HEADER_BYTES)).toBe(0);
    expect(() => plaintextSizeFromOnDisk(MEDIA_FILE_HEADER_BYTES - 1)).toThrow();
    expect(() => plaintextSizeFromOnDisk(MEDIA_FILE_HEADER_BYTES + MEDIA_FILE_TAG_BYTES)).toThrow();
    expect(() => plaintextSizeFromOnDisk(-1)).toThrow();
  });
});
