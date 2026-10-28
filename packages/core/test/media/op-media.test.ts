import { describe, expect, test } from 'vitest';

import { mediaRefsInPayload } from '../../src/media/op-media.js';

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

describe('mediaRefsInPayload', () => {
  test('finds refs at any depth, in arrays and records, once each', () => {
    const payload = {
      photos: { front: ref(A), back: ref(B) },
      evidence: [ref(A)],
      note: 'x',
    };
    expect(mediaRefsInPayload(payload)).toEqual([ref(A), ref(B)]);
  });

  test('finds a video clip ref too', () => {
    const clip = { ...ref(B), mime: 'video/mp4', type: 'video' };
    expect(mediaRefsInPayload({ ownershipVideo: clip, photo: ref(A) })).toEqual([clip, ref(A)]);
    // A photo slot cannot carry a clip's mime: such a ref matches neither shape.
    expect(mediaRefsInPayload({ photo: { ...ref(A), mime: 'video/mp4' } })).toEqual([]);
  });

  test('ignores incomplete refs and plain values', () => {
    expect(mediaRefsInPayload({ mediaId: A })).toEqual([]);
    expect(mediaRefsInPayload(null)).toEqual([]);
    expect(mediaRefsInPayload('text')).toEqual([]);
  });
});
