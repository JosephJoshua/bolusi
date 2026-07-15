// Unit tests for assembly + integrity primitives (api/03-media §3.4). The magic-byte and hash
// checks are the load-bearing content-validation guards (falsified in the task report); this file
// pins their exact behavior at the class level (T-12): both mimes, a mismatch, and a short file.
import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';

import { assembleChunks, isAllowedMime, magicBytesMatch } from './assemble.js';

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytes(prefix: number[], padTo = 0): Uint8Array {
  const out = new Uint8Array(Math.max(prefix.length, padTo));
  out.set(prefix, 0);
  return out;
}

describe('assembleChunks', () => {
  test('concatenates chunks in order and hashes the assembled bytes', () => {
    const a = Uint8Array.from([1, 2, 3]);
    const b = Uint8Array.from([4, 5]);
    const c = Uint8Array.from([6]);
    const assembled = assembleChunks([a, b, c]);
    expect([...assembled.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    const expected = createHash('sha256')
      .update(Uint8Array.from([1, 2, 3, 4, 5, 6]))
      .digest('hex');
    expect(assembled.sha256).toBe(expected);
  });

  test('empty input → empty bytes + sha of empty', () => {
    const assembled = assembleChunks([]);
    expect(assembled.bytes.length).toBe(0);
    expect(assembled.sha256).toBe(createHash('sha256').update(new Uint8Array(0)).digest('hex'));
  });
});

describe('magicBytesMatch (the whole v0 allowlist — T-12)', () => {
  test('jpeg magic matches image/jpeg, not image/png', () => {
    expect(magicBytesMatch(bytes(JPEG, 20), 'image/jpeg')).toBe(true);
    expect(magicBytesMatch(bytes(JPEG, 20), 'image/png')).toBe(false);
  });

  test('png magic matches image/png, not image/jpeg', () => {
    expect(magicBytesMatch(bytes(PNG, 20), 'image/png')).toBe(true);
    expect(magicBytesMatch(bytes(PNG, 20), 'image/jpeg')).toBe(false);
  });

  test('a near-miss prefix (one byte off) does not match', () => {
    const almostJpeg = Uint8Array.from([0xff, 0xd8, 0xfe, 0, 0]);
    expect(magicBytesMatch(almostJpeg, 'image/jpeg')).toBe(false);
  });

  test('a file shorter than the signature never matches', () => {
    expect(magicBytesMatch(Uint8Array.from([0x89, 0x50]), 'image/png')).toBe(false);
  });
});

describe('isAllowedMime', () => {
  test('accepts the v0 allowlist, rejects everything else', () => {
    expect(isAllowedMime('image/jpeg')).toBe(true);
    expect(isAllowedMime('image/png')).toBe(true);
    expect(isAllowedMime('image/gif')).toBe(false);
    expect(isAllowedMime('video/mp4')).toBe(false); // reserved for v1
    expect(isAllowedMime('application/octet-stream')).toBe(false);
  });
});
