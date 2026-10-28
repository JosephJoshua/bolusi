// The notes media-seam SELECTION is a tested contract, not a silent fallback (task 120; §2.11).
//
// WHY THIS TEST EXISTS. `createNotes` binds the notes thumbnail loader to the app's media client, or
// to `UNWIRED_NOTES_MEDIA` when there is none. The `null` branch is a FALLBACK, and a silent fallback
// is the exact failure this repo keeps shipping: a note photo that resolves `unavailable` throws
// nothing, logs nothing, and reds no test — and api/03 §8 makes `unavailable` an EXPECTED, transient
// state, so on screen it is indistinguishable from a photo that simply has not uploaded. "If the
// media client failed to reach the thumbnail path, what would notice?" — before this test, nothing.
//
// So the choice was pulled out of the composition root into `notesMediaSeamsFor`, and this asserts
// both arms: a real client is REACHED (its outcome shows up), and its absence resolves `unavailable`
// on purpose rather than by accident. Break the wiring — bind `null`, or drop the delegation — and
// one of these reds instead of a photo silently vanishing on a real device.
import { describe, expect, test, vi } from 'vitest';

import type { MediaClient } from '../media/client.js';

import { notesMediaSeamsFor, UNWIRED_NOTES_MEDIA } from './notes.js';

/** A media client whose `loadForRender` returns a fixed cached uri — enough to prove it was reached. */
function fakeMediaClient(): MediaClient {
  return {
    loadForRender: vi.fn(() => Promise.resolve({ kind: 'cached', uri: 'file:///c/photo.jpg' })),
    loadLocalForRender: vi.fn(() => Promise.resolve({ kind: 'unavailable', code: null })),
  } as unknown as MediaClient;
}

describe('notesMediaSeamsFor — the fallback is a tested fact, not a silence', () => {
  test('media PRESENT: a signed ref reaches the real client and renders its verified result', async () => {
    const client = fakeMediaClient();
    const seams = notesMediaSeamsFor(client);

    const state = await seams.loadThumbnail({
      kind: 'signed',
      mediaId: 'm-1',
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
    });

    // The client's outcome ('cached') surfaced as a rendered image. This is the leg that goes RED if
    // `notesMediaSeamsFor` binds the unwired loader while a real client is present — i.e. the exact
    // "media never reaches the thumbnail path" regression.
    expect(state).toStrictEqual({ kind: 'ready', uri: 'file:///c/photo.jpg' });
    expect(client.loadForRender).toHaveBeenCalledWith({
      mediaId: 'm-1',
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
    });
  });

  test('media PRESENT: a legacy ref goes to the local-only path, never a fetch', async () => {
    const client = fakeMediaClient();
    const seams = notesMediaSeamsFor(client);

    await seams.loadThumbnail({ kind: 'legacy', mediaId: 'm-2' });

    // A legacy note (no signed hash) must NOT reach `loadForRender` — there is nothing to verify its
    // bytes against, so fetching would be exactly the unverified render 06 §6 forbids.
    expect(client.loadForRender).not.toHaveBeenCalled();
    expect(client.loadLocalForRender).toHaveBeenCalledWith('m-2');
  });

  test('media ABSENT (the fallback): every attachment resolves unavailable, LOUDLY tested', async () => {
    const seams = notesMediaSeamsFor(null);

    // It is literally the unwired seams — asserted, so the fallback is a decision the suite checks,
    // not an accident nobody sees.
    expect(seams).toBe(UNWIRED_NOTES_MEDIA);
    const state = await seams.loadThumbnail({
      kind: 'signed',
      mediaId: 'm-3',
      sha256: 'b'.repeat(64),
      mime: 'image/jpeg',
    });
    expect(state).toStrictEqual({ kind: 'unavailable' });
  });
});
