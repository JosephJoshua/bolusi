// NoteDetail MOUNTED-screen tests (task 96 / §2.11). The four §5 states, the rejected-op DANGER
// banner (the falsified deliverable), archive-through-ConfirmSheet, and the verified media thumbnail.
import { DomainError } from '@bolusi/core';
import { NoteDetail } from '@bolusi/modules/notes/screens';
import type { ArchiveNoteInput, NoteRow } from '@bolusi/modules/notes';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { fakeRuntime, fire, page, renderNotes } from '../../../test/notes-support.js';

const NOW = 1_726_000_600_000;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const note = (over: Partial<NoteRow> = {}): NoteRow => ({
  id: 'note-1',
  title: 'Layar retak',
  body: 'Ganti LCD',
  mediaId: null,
  archived: false,
  editCount: 0,
  createdBy: 'user-1',
  createdAt: 1,
  lastEditedBy: 'user-1',
  lastEditedAt: 1,
  ...over,
});

function detail(rt: ReturnType<typeof fakeRuntime>, over: Partial<Record<string, unknown>> = {}) {
  return renderNotes(
    rt,
    <NoteDetail
      noteId="note-1"
      now={NOW}
      syncChip={null}
      avatar={null}
      onBack={(over['onBack'] as () => void) ?? vi.fn()}
      onEdit={(over['onEdit'] as (id: string) => void) ?? vi.fn()}
      onOpenSyncStatus={vi.fn()}
    />,
  );
}

describe('NoteDetail — the four §5 states', () => {
  test('ready: renders the note with edit + archive actions', async () => {
    const screen = detail(fakeRuntime({ getNote: () => Promise.resolve(page([note()])) }));
    expect(screen.query('notes.detail.loading')).not.toBeNull();
    await settle();

    expect(screen.get('notes.detail.heading').props['children']).toBe('Layar retak');
    expect(screen.query('notes.detail.edit')).not.toBeNull();
    expect(screen.query('notes.detail.archive')).not.toBeNull();
  });

  test('unauthorized: a denied read renders Unauthorized, never the note', async () => {
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.reject(new DomainError('PERMISSION_DENIED', {}, 'no')),
      }),
    );
    await settle();
    expect(screen.query('notes.detail.unauthorized')).not.toBeNull();
    expect(screen.query('notes.detail.card')).toBeNull();
  });

  test('not-found → Empty; other error → Error', async () => {
    const gone = detail(
      fakeRuntime({ getNote: () => Promise.reject(new DomainError('ENTITY_NOT_FOUND', {}, 'x')) }),
    );
    await settle();
    expect(gone.query('notes.detail.empty')).not.toBeNull();

    const broken = detail(
      fakeRuntime({ getNote: () => Promise.reject(new DomainError('VALIDATION_FAILED', {}, 'x')) }),
    );
    await settle();
    expect(broken.query('notes.detail.error')).not.toBeNull();
  });

  test('an archived note hides edit + archive and shows the archived badge (archived is terminal)', async () => {
    const screen = detail(
      fakeRuntime({ getNote: () => Promise.resolve(page([note({ archived: true })])) }),
    );
    await settle();
    expect(screen.query('notes.detail.archivedBadge')).not.toBeNull();
    expect(screen.query('notes.detail.edit')).toBeNull();
    expect(screen.query('notes.detail.archive')).toBeNull();
  });
});

describe('NoteDetail — rejected-op danger banner (the falsified deliverable)', () => {
  test('a note with a rejected op renders the danger banner inline', async () => {
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.resolve(page([note()])),
        noteSyncStatuses: () => Promise.resolve({ 'note-1': ['rejected'] }),
      }),
    );
    await settle();
    expect(screen.query('notes.detail.rejectedBanner')).not.toBeNull();
  });

  test('POSITIVE CONTROL: an all-synced note renders NO banner (the banner tracks state)', async () => {
    // Without this, a screen that rendered the banner unconditionally would pass the test above.
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.resolve(page([note()])),
        noteSyncStatuses: () => Promise.resolve({ 'note-1': ['synced'] }),
      }),
    );
    await settle();
    expect(screen.query('notes.detail.rejectedBanner')).toBeNull();
  });
});

describe('NoteDetail — archive through the ConfirmSheet', () => {
  test('archive opens the ConfirmSheet first, then fires the command on confirm', async () => {
    let archived: ArchiveNoteInput | null = null;
    const onBack = vi.fn();
    const rt = fakeRuntime({
      getNote: () => Promise.resolve(page([note()])),
      archiveNote: (input) => {
        archived = input;
        return Promise.resolve({ noteId: input.noteId });
      },
    });
    const screen = detail(rt, { onBack });
    await settle();

    // Pressing archive must NOT fire the command — it opens the sheet (§3.10 destructive confirm).
    fire(screen.get('notes.detail.archive'), 'onPress');
    expect(screen.query('notes.detail.archiveConfirm')).not.toBeNull();
    expect(archived).toBeNull();

    // Confirming fires it (optimistically) and returns to the list.
    fire(screen.get('notes.detail.archiveConfirm.confirm'), 'onPress');
    expect(archived).toStrictEqual({ noteId: 'note-1' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('NoteDetail — verified media thumbnail (06 §6)', () => {
  test('a ready thumbnail renders the resolved local uri', async () => {
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.resolve(page([note({ mediaId: 'media-1' })])),
        loadThumbnail: () => Promise.resolve({ kind: 'ready', uri: 'file:///cache/media-1.jpg' }),
      }),
    );
    await settle();
    const image = screen.get('notes.detail.thumb.image');
    expect((image.props['source'] as { uri: string }).uri).toBe('file:///cache/media-1.jpg');
  });

  test('a mismatch (failed hash verification) never shows bytes — a distinct danger state', async () => {
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.resolve(page([note({ mediaId: 'media-1' })])),
        loadThumbnail: () => Promise.resolve({ kind: 'mismatch' }),
      }),
    );
    await settle();
    expect(screen.query('notes.detail.thumb.image')).toBeNull();
    expect(screen.query('notes.detail.thumb.mismatch')).not.toBeNull();
  });

  test('an unavailable thumbnail (op precedes media) is a calm placeholder, not an error', async () => {
    const screen = detail(
      fakeRuntime({
        getNote: () => Promise.resolve(page([note({ mediaId: 'media-1' })])),
        loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
      }),
    );
    await settle();
    expect(screen.query('notes.detail.thumb.unavailable')).not.toBeNull();
    expect(screen.query('notes.detail.thumb.image')).toBeNull();
  });
});
