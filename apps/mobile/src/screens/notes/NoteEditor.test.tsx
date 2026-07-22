// NoteEditor MOUNTED-screen tests (task 96 / §2.11). The optimistic save (the falsified deliverable),
// title validation, the edit path's four §5 states, the discard ConfirmSheet, and the media capture.
import { DomainError } from '@bolusi/core';
import { NoteEditor } from '@bolusi/modules/notes/screens';
import type { CreateNoteInput, EditNoteBodyInput } from '@bolusi/modules/notes';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';

import {
  fakeRuntime,
  fire,
  page,
  renderNotes,
  TEST_MEDIA_REF,
} from '../../../test/notes-support.js';
import type { NoteRow } from '@bolusi/modules/notes';

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const note = (over: Partial<NoteRow> = {}): NoteRow => ({
  id: 'note-1',
  title: 'Judul lama',
  body: 'Isi lama',
  mediaId: null,
  mediaSha256: null,
  mediaMime: null,
  archived: false,
  editCount: 0,
  createdBy: 'user-1',
  createdAt: 1,
  lastEditedBy: 'user-1',
  lastEditedAt: 1,
  ...over,
});

describe('NoteEditor — optimistic save (the falsified deliverable)', () => {
  test('create: save fires the command and returns to the list in the SAME tick, no spinner', async () => {
    let captured: CreateNoteInput | null = null;
    const onDone = vi.fn();
    // NEVER-resolving createNote: if the save handler awaited it (the broken, blocking version),
    // `onDone` could never fire. Optimistic save fires-and-returns, so `onDone` runs immediately.
    const rt = fakeRuntime({
      createNote: (input) => {
        captured = input;
        return new Promise<{ readonly noteId: string }>(() => undefined);
      },
    });
    const screen = renderNotes(
      rt,
      <NoteEditor mode="create" syncChip={null} avatar={null} onDone={onDone} onCancel={vi.fn()} />,
    );

    fire(screen.get('notes.editor.title.field'), 'onChangeText', 'Judul baru');
    fire(screen.get('notes.editor.body.field'), 'onChangeText', 'Isi baru');
    fire(screen.get('notes.editor.save'), 'onPress');

    expect(onDone).toHaveBeenCalledTimes(1); // returned to the list without awaiting the command
    expect(captured).toStrictEqual({ title: 'Judul baru', body: 'Isi baru', mediaRef: null });
    expect(screen.query('notes.editor.save.spinner')).toBeNull(); // never a busy spinner (§4.2)
  });

  test('create: an empty title blocks the save (inline titleRequired), no command, no navigation', async () => {
    const createNote = vi.fn(() => Promise.resolve({ noteId: 'x' }));
    const onDone = vi.fn();
    const screen = renderNotes(
      fakeRuntime({ createNote }),
      <NoteEditor mode="create" syncChip={null} avatar={null} onDone={onDone} onCancel={vi.fn()} />,
    );

    fire(screen.get('notes.editor.save'), 'onPress');

    expect(screen.query('notes.editor.title.error')).not.toBeNull(); // the titleRequired adornment
    expect(createNote).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  test('edit: save fires editNoteBody with the new body and returns to the list', async () => {
    let captured: EditNoteBodyInput | null = null;
    const onDone = vi.fn();
    const rt = fakeRuntime({
      getNote: () => Promise.resolve(page([note()])),
      editNoteBody: (input) => {
        captured = input;
        return new Promise<{ readonly noteId: string }>(() => undefined);
      },
    });
    const screen = renderNotes(
      rt,
      <NoteEditor
        mode="edit"
        noteId="note-1"
        syncChip={null}
        avatar={null}
        onDone={onDone}
        onCancel={vi.fn()}
      />,
    );
    await settle();

    // The title is read-only in edit (01 §9): its field announces disabled.
    expect(screen.get('notes.editor.title.field').props['editable']).toBe(false);

    fire(screen.get('notes.editor.body.field'), 'onChangeText', 'Isi baru');
    fire(screen.get('notes.editor.save'), 'onPress');

    expect(captured).toStrictEqual({ noteId: 'note-1', body: 'Isi baru' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// ── task 128: the BODY wraps, the TITLE does not ─────────────────────────────────────────────────
// The body shipped as a single-line box (RN's `multiline` default is `false`), clipping a repair
// note at ~35 characters on a 360 dp phone. Nothing above went red, because every assertion here
// asked whether the field RENDERED — the exact trap the visual sweep found 35 times. These read the
// `multiline` prop that reaches the RN primitive: delete the wiring and they are the ones that fail.
describe('NoteEditor — the body is a multiline field, the title stays single-line (§8.6)', () => {
  test('create: the body field tells RN it is multiline; the title field does not', () => {
    const screen = renderNotes(
      fakeRuntime(),
      <NoteEditor
        mode="create"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.get('notes.editor.body.field').props['multiline']).toBe(true);
    expect(screen.get('notes.editor.title.field').props['multiline']).toBe(false);
  });

  test('create: a long body is laid out to wrap, not clipped to one line', () => {
    const screen = renderNotes(
      fakeRuntime(),
      <NoteEditor
        mode="create"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const long =
      'Sisa 4 karung di gudang belakang. Pesan ulang sebelum akhir minggu, dan cek juga rak atas.';
    fire(screen.get('notes.editor.body.field'), 'onChangeText', long);

    // The whole value is held (never truncated by the field) AND the box is taller than a single
    // line, top-aligned, and bounded — the four properties that turn "wraps" into something a
    // declared style can actually witness in this lane.
    expect(screen.get('notes.editor.body.field').props['value']).toBe(long);
    expect(screen.get('notes.editor.body.field').props['multiline']).toBe(true);
    const style = screen.styleOf('notes.editor.body.field');
    expect(style['textAlignVertical']).toBe('top');
    expect(Number(style['minHeight'])).toBeGreaterThan(Number(style['maxHeight']) / 2);
    expect(Number(style['maxHeight'])).toBeGreaterThan(Number(style['minHeight']));
  });

  test('edit: the loaded body is multiline too — the mode the QA repro walked through', async () => {
    const screen = renderNotes(
      fakeRuntime({ getNote: () => Promise.resolve(page([note()])) }),
      <NoteEditor
        mode="edit"
        noteId="note-1"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await settle();

    expect(screen.get('notes.editor.body.field').props['multiline']).toBe(true);
    expect(screen.get('notes.editor.title.field').props['multiline']).toBe(false);
  });
});

describe('NoteEditor — edit path ships the four §5 states', () => {
  const editor = (rt: ReturnType<typeof fakeRuntime>) =>
    renderNotes(
      rt,
      <NoteEditor
        mode="edit"
        noteId="note-1"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

  test('loading → ready renders the prefilled form', async () => {
    const screen = editor(fakeRuntime({ getNote: () => Promise.resolve(page([note()])) }));
    expect(screen.query('notes.editor.loading')).not.toBeNull();
    await settle();
    expect(screen.get('notes.editor.body.field').props['value']).toBe('Isi lama');
  });

  test('unauthorized: a denied read renders Unauthorized (never the form)', async () => {
    const screen = editor(
      fakeRuntime({
        getNote: () => Promise.reject(new DomainError('PERMISSION_DENIED', {}, 'no')),
      }),
    );
    await settle();
    expect(screen.query('notes.editor.unauthorized')).not.toBeNull();
    expect(screen.query('notes.editor.body')).toBeNull();
  });

  test('not-found → Empty; other error → Error with retry', async () => {
    const gone = editor(
      fakeRuntime({
        getNote: () => Promise.reject(new DomainError('ENTITY_NOT_FOUND', {}, 'gone')),
      }),
    );
    await settle();
    expect(gone.query('notes.editor.empty')).not.toBeNull();

    const broken = editor(
      fakeRuntime({ getNote: () => Promise.reject(new DomainError('VALIDATION_FAILED', {}, 'x')) }),
    );
    await settle();
    expect(broken.query('notes.editor.error')).not.toBeNull();
  });
});

describe('NoteEditor — discard ConfirmSheet + media capture', () => {
  test('a back press with unsaved input opens the ConfirmSheet; confirm discards', async () => {
    const onCancel = vi.fn();
    const screen = renderNotes(
      fakeRuntime(),
      <NoteEditor
        mode="create"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // Clean input → back leaves immediately, no sheet.
    fire(screen.get('notes.editor.back'), 'onPress');
    expect(screen.query('notes.editor.discard')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Dirty input → back opens the sheet instead.
    fire(screen.get('notes.editor.title.field'), 'onChangeText', 'sesuatu');
    fire(screen.get('notes.editor.back'), 'onPress');
    expect(screen.query('notes.editor.discard')).not.toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1); // not yet discarded

    fire(screen.get('notes.editor.discard.confirm'), 'onPress');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test('capture attaches a MediaItem, and the created note carries its id', async () => {
    let captured: CreateNoteInput | null = null;
    const rt = fakeRuntime({
      capturePhoto: () => Promise.resolve({ mediaRef: TEST_MEDIA_REF }),
      createNote: (input) => {
        captured = input;
        return Promise.resolve({ noteId: 'note-new' });
      },
    });
    const screen = renderNotes(
      rt,
      <NoteEditor
        mode="create"
        syncChip={null}
        avatar={null}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.query('notes.editor.attached')).toBeNull();
    await act(async () => {
      fire(screen.get('notes.editor.attach'), 'onPress');
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(screen.query('notes.editor.attached')).not.toBeNull(); // the attached indicator

    fire(screen.get('notes.editor.title.field'), 'onChangeText', 'Layar retak');
    fire(screen.get('notes.editor.save'), 'onPress');
    expect(captured).toStrictEqual({ title: 'Layar retak', body: '', mediaRef: TEST_MEDIA_REF });
  });
});
