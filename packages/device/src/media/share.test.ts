import { describe, expect, test, vi } from 'vitest';

import type { ThumbnailState } from '@bolusi/modules/screen-kit';

import { createPhotoSharer, type SharePlatform } from './share.js';

const REF = { kind: 'signed', mediaId: 'm-1', sha256: 'abc', mime: 'image/png' } as const;

function platform(available = true): SharePlatform & { share: ReturnType<typeof vi.fn> } {
  return {
    isAvailable: () => Promise.resolve(available),
    share: vi.fn(() => Promise.resolve()),
  };
}

describe('sharing a repair photo', () => {
  test('hands the verified file to the share sheet with its type', async () => {
    const sheet = platform();
    const share = createPhotoSharer(
      () => Promise.resolve({ kind: 'ready', uri: 'file:///media/m-1.png' }),
      sheet,
    );
    expect(await share(REF)).toBe('done');
    expect(sheet.share).toHaveBeenCalledWith('file:///media/m-1.png', 'image/png');
  });

  test.each<ThumbnailState>([{ kind: 'loading' }, { kind: 'unavailable' }, { kind: 'mismatch' }])(
    'never shares a photo that is not verified and on the device ($kind)',
    async (state) => {
      const sheet = platform();
      const share = createPhotoSharer(() => Promise.resolve(state), sheet);
      expect(await share(REF)).toBe('failed');
      expect(sheet.share).not.toHaveBeenCalled();
    },
  );

  test('answers failed when the loader throws or the device has no share sheet', async () => {
    const sheet = platform();
    expect(await createPhotoSharer(() => Promise.reject(new Error('io')), sheet)(REF)).toBe(
      'failed',
    );
    const none = platform(false);
    const ready = (): Promise<ThumbnailState> =>
      Promise.resolve({ kind: 'ready', uri: 'file:///x' });
    expect(await createPhotoSharer(ready, none)(REF)).toBe('failed');
    expect(sheet.share).not.toHaveBeenCalled();
    expect(none.share).not.toHaveBeenCalled();
  });
});
