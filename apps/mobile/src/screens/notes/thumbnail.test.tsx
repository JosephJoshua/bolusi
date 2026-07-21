// NoteDetail renders a PULLED note's photo only when it verifies against the SIGNED hash (task 120).
//
// This is the end-to-end leg: the note row carries the sha256 the v3 fold wrote from a signed
// payload, the bridge hands it to the REAL `loadMediaForRender`, which runs the REAL
// `fetchAndVerifyMedia`, and the screen renders whatever comes back. Nothing between the hash and
// the pixels is stubbed — the only fakes are the leaves that would otherwise be a network and a
// filesystem.
//
// The reason it exists as a SCREEN test and not only a unit one: `mismatch` is a state a user has to
// SEE. A verify that correctly returns `mismatch` into a screen that renders the image anyway (or
// that quietly shows "not available") is the same failure as no verify at all, and no unit test of
// `fetchAndVerifyMedia` can catch it.
import { createHash } from 'node:crypto';

import type { NoteRow } from '@bolusi/modules/notes';
import { NoteDetail } from '@bolusi/modules/notes/screens';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fakeRuntime, page, renderNotes } from '../../../test/notes-support.js';
import type { MediaClient } from '../../media/client.js';
import { loadMediaForRender } from '../../media/remote-cache.js';

import { createNotesThumbnailLoader } from './thumbnail.js';

const NOW = 1_726_000_600_000;
const MEDIA_ID = '01920000-0000-7000-8000-0000000f0099';

/** The bytes the remote device actually captured, and the hash its signed payload therefore pins. */
const REAL_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const REAL_SHA256 = createHash('sha256').update(REAL_BYTES).digest('hex');
/** What a hostile or broken server hands back instead. */
const TAMPERED_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 5]);

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** A note PULLED from another device: it carries the signed hash and has NO local file. */
const remoteNote = (over: Partial<NoteRow> = {}): NoteRow => ({
  id: 'note-1',
  title: 'Layar retak',
  body: 'dari perangkat lain',
  mediaId: MEDIA_ID,
  mediaSha256: REAL_SHA256,
  mediaMime: 'image/jpeg',
  archived: false,
  editCount: 0,
  createdBy: 'user-1',
  createdAt: 1,
  lastEditedBy: 'user-1',
  lastEditedAt: 1,
  ...over,
});

/**
 * A media client whose `loadForRender` is the REAL one, over leaf fakes.
 *
 * `localPathFor` returns null throughout — that is what makes this a PULLED note. If it returned a
 * path, the local branch would short-circuit and the verify under test would never run, which is
 * exactly the way this test could quietly stop testing anything.
 */
function mediaClientServing(bytes: Uint8Array): MediaClient {
  const cache = new Map<string, Uint8Array>();
  return {
    loadForRender: (ref: Parameters<MediaClient['loadForRender']>[0]) =>
      loadMediaForRender(
        {
          transport: { download: () => Promise.resolve(bytes) } as never,
          crypto: {
            sha256: (data: Uint8Array) =>
              new Uint8Array(createHash('sha256').update(data).digest()),
          } as never,
          files: {
            exists: () => Promise.resolve(false),
            hashFile: (path: string) => {
              const stored = cache.get(path);
              if (stored === undefined) throw new Error(`no cached file ${path}`);
              return Promise.resolve(createHash('sha256').update(stored).digest('hex'));
            },
          } as never,
          localPathFor: () => Promise.resolve(null),
          findCached: (id, ext) => (cache.has(`/c/${id}.${ext}`) ? `/c/${id}.${ext}` : null),
          writeCached: (id, ext, written) => {
            const path = `/c/${id}.${ext}`;
            cache.set(path, written);
            return path;
          },
          evictCached: (id) => cache.delete(`/c/${id}.jpg`),
        },
        ref,
      ),
    loadLocalForRender: () => Promise.resolve({ kind: 'unavailable', code: null }),
  } as unknown as MediaClient;
}

function detailWith(bytes: Uint8Array, note: NoteRow = remoteNote()) {
  return renderNotes(
    fakeRuntime({
      getNote: () => Promise.resolve(page([note])),
      loadThumbnail: createNotesThumbnailLoader(mediaClientServing(bytes)),
    }),
    <NoteDetail
      noteId="note-1"
      now={NOW}
      syncChip={null}
      avatar={null}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onOpenSyncStatus={vi.fn()}
    />,
  );
}

describe('a PULLED note verifies its thumbnail against the SIGNED sha256 (06 §6)', () => {
  test('POSITIVE CONTROL: bytes matching the signed hash render as an image', async () => {
    // Without this, a bridge that returned `mismatch` unconditionally would satisfy the test below
    // and look like a working integrity check while never showing a photo again.
    const screen = detailWith(REAL_BYTES);
    await settle();

    expect(screen.query('notes.detail.thumb.image')).not.toBeNull();
    expect(screen.query('notes.detail.thumb.mismatch')).toBeNull();
  });

  test('TAMPERED bytes render the MISMATCH state — never the image', async () => {
    const screen = detailWith(TAMPERED_BYTES);
    await settle();

    // The substituted photo is not shown. This is the whole security property, at the pixel.
    expect(screen.query('notes.detail.thumb.image')).toBeNull();
    expect(screen.query('notes.detail.thumb.mismatch')).not.toBeNull();
    // …and it is the DANGER state, not the calm "not available yet" one — a user must be able to
    // tell "the photo hasn't arrived" from "the photo is not what was signed".
    expect(screen.query('notes.detail.thumb.unavailable')).toBeNull();
  });

  test('a LEGACY v2 note (no signed hash) is never fetched — local file or nothing', async () => {
    // The legacy arm routes to `loadLocalForRender`, which cannot reach the network. Serving REAL
    // bytes proves the point: even bytes that WOULD verify are not fetched, because there is no
    // signed hash to have verified them against.
    const legacy = remoteNote({ mediaSha256: null, mediaMime: null });
    const screen = detailWith(REAL_BYTES, legacy);
    await settle();

    expect(screen.query('notes.detail.thumb.image')).toBeNull();
    expect(screen.query('notes.detail.thumb.unavailable')).not.toBeNull();
  });
});
