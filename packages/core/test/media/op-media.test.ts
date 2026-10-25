import { describe, expect, test } from 'vitest';

import { mediaIdsInPayload } from '../../src/media/op-media.js';

const ref = (mediaId: string) => ({
  mediaId,
  sha256: 'a'.repeat(64),
  mime: 'image/jpeg',
  type: 'image',
  sizeBytes: 10,
  capturedAt: 1,
  location: null,
  userId: '01920000-0000-7000-8000-0000000e000a',
  deviceId: '01920000-0000-7000-8000-0000000d000a',
});

const A = '01920000-0000-7000-8000-0000000f0001';
const B = '01920000-0000-7000-8000-0000000f0002';

describe('mediaIdsInPayload', () => {
  test('finds refs at any depth, in arrays and records, once each', () => {
    const payload = {
      photos: { front: ref(A), back: ref(B) },
      evidence: [ref(A)],
      note: 'x',
    };
    expect(mediaIdsInPayload(payload)).toEqual([A, B]);
  });

  test('ignores incomplete refs and plain values', () => {
    expect(mediaIdsInPayload({ mediaId: A })).toEqual([]);
    expect(mediaIdsInPayload(null)).toEqual([]);
    expect(mediaIdsInPayload('text')).toEqual([]);
  });
});
