// NotesList MOUNTED-screen tests (task 96 / §2.11 / task 69's "a screen not mounted is uncovered").
// The four §5 states, the unauthorized≠empty proof, live-update via the real pull path, the
// attachment glyph, and the i18n live-switch — each asserted on a RENDERED tree, not a model.
import { DomainError } from '@bolusi/core';
import { NotesList } from '@bolusi/modules/notes/screens';
import { DEFAULT_LOCALE, setLocale } from '@bolusi/i18n';
import type { ReactElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureNotesCatalog,
  fakeRuntime,
  harnessRuntime,
  NotesRuntimeProvider,
  openHarness,
  page,
  remoteNoteCreated,
  render,
  renderNotes,
  type Harness,
  TEST_MEDIA_REF,
} from '../../../test/notes-support.js';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';

const NOW = 1_726_000_600_000;

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  setLocale(DEFAULT_LOCALE);
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function listElement(): ReactElement {
  return (
    <NotesList
      now={NOW}
      syncChip={null}
      avatar={null}
      onOpenNote={vi.fn()}
      onCreateNote={vi.fn()}
      onOpenSyncStatus={vi.fn()}
    />
  );
}

const mount = (runtime: NotesRuntime) => renderNotes(runtime, listElement());

describe('NotesList — the four §5 states on a mounted screen', () => {
  test('ready: a seeded note renders as a row (loading resolves to the list)', async () => {
    h = await openHarness(1);
    const rt = harnessRuntime(h, h.notesUserId);
    const created = await rt.createNote({
      title: 'Stok kopi',
      body: 'Sisa 4 karung',
      mediaRef: null,
    });

    const screen = mount(rt);
    expect(screen.query('notes.list.items.loading')).not.toBeNull(); // local query still loading

    await settle();
    expect(screen.query(`notes.list.row.${created.noteId}`)).not.toBeNull();
    expect(screen.query('notes.list.items.empty')).toBeNull();
    expect(screen.query('notes.list.items.unauthorized')).toBeNull();
  });

  test('empty WITH create permission → EmptyState renders the create CTA', async () => {
    const screen = mount(
      fakeRuntime({ hasPermission: () => true, listNotes: () => Promise.resolve(page([])) }),
    );
    await settle();

    expect(screen.query('notes.list.items.empty')).not.toBeNull();
    expect(screen.query('ui.emptyState.cta')).not.toBeNull(); // the create CTA
    expect(screen.query('notes.list.create')).not.toBeNull(); // the bottom-action create button
  });

  test('create-CTA GATE: empty WITHOUT create permission → EmptyState, but NO create CTA', async () => {
    const screen = mount(
      fakeRuntime({ hasPermission: () => false, listNotes: () => Promise.resolve(page([])) }),
    );
    await settle();

    // Still the EMPTY state (a permitted-but-empty read) — distinct from unauthorized.
    expect(screen.query('notes.list.items.empty')).not.toBeNull();
    // The CTA is absent on BOTH surfaces, because the user cannot create (design-system §5/§8.6).
    expect(screen.query('ui.emptyState.cta')).toBeNull();
    expect(screen.query('notes.list.create')).toBeNull();
  });

  test('UNAUTHORIZED ≠ EMPTY: a zero-grant read renders Unauthorized, never Empty (FR-1036)', async () => {
    h = await openHarness(2);
    // The literal 04 §8 denial case: a user holding NO notes grants. `listNotes` throws
    // PERMISSION_DENIED in the runtime, and the screen must render the Unauthorized state.
    const screen = mount(harnessRuntime(h, h.zeroUserId));
    await settle();

    expect(screen.query('notes.list.items.unauthorized')).not.toBeNull();
    // The falsified property: a denial is NEVER an empty list. Map denial→empty (the FR-1036 bug)
    // and the unauthorized assertion goes null while this one goes non-null → red.
    expect(screen.query('notes.list.items.empty')).toBeNull();
    expect(screen.query('notes.list.create')).toBeNull();
  });

  test('error: a non-permission failure renders the Error state (not unauthorized)', async () => {
    const screen = mount(
      fakeRuntime({
        hasPermission: () => true,
        listNotes: () =>
          Promise.reject(new DomainError('VALIDATION_FAILED', { issue: 'x' }, 'boom')),
      }),
    );
    await settle();

    expect(screen.query('notes.list.items.error')).not.toBeNull();
    expect(screen.query('notes.list.items.unauthorized')).toBeNull();
  });
});

describe('NotesList — media glyph + live update', () => {
  test('attachment glyph shows for a note with media, and is absent without', async () => {
    h = await openHarness(3);
    const rt = harnessRuntime(h, h.notesUserId);
    const withMedia = await rt.createNote({ title: 'Rusak', body: '', mediaRef: TEST_MEDIA_REF });
    const withoutMedia = await rt.createNote({ title: 'Tanpa foto', body: '', mediaRef: null });

    const screen = mount(rt);
    await settle();

    expect(screen.query(`notes.list.row.${withMedia.noteId}`)).not.toBeNull();
    expect(screen.query(`notes.list.attach.${withMedia.noteId}`)).not.toBeNull();
    // Same row present, but no glyph — the glyph is driven by `mediaId`, not decoration.
    expect(screen.query(`notes.list.row.${withoutMedia.noteId}`)).not.toBeNull();
    expect(screen.query(`notes.list.attach.${withoutMedia.noteId}`)).toBeNull();
  });

  test('LIVE UPDATE: a remote op via the real pull path re-renders the mounted list (04 §7)', async () => {
    h = await openHarness(4);
    const screen = mount(harnessRuntime(h, h.notesUserId));
    await settle();
    expect(screen.query('notes.list.items.empty')).not.toBeNull(); // nothing yet

    // A remote note arrives via the PULL path (deliverPulled → applyPulledOp → notes-table
    // invalidation). The mounted screen's subscribed useQuery must re-run and render the new row.
    const remote = remoteNoteCreated(h, {
      id: '01920000-0000-7000-8000-00000000e001',
      title: 'from another device',
      body: 'pulled',
      timestamp: NOW,
    });
    await act(async () => {
      await h!.deliverPulled(remote, 1);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(screen.query(`notes.list.row.${remote.entityId}`)).not.toBeNull();
    expect(screen.query('notes.list.items.empty')).toBeNull();
  });
});

describe('NotesList — i18n live-switch (zero hardcoded strings)', () => {
  test('the list title switches ID→EN when the locale changes and the tree re-renders', async () => {
    ensureNotesCatalog();
    const rt = fakeRuntime({ hasPermission: () => true });
    const wrapped = () => <NotesRuntimeProvider runtime={rt}>{listElement()}</NotesRuntimeProvider>;
    const screen = render(wrapped());
    await settle();

    // Boots in `id` (mobile setup) — the title resolves the notes MODULE key from the catalog.
    expect(screen.get('notes.list.title').props['children']).toBe('Catatan');

    // The app re-renders the tree on a locale change (Root's setLocale); simulate that here.
    await act(async () => {
      setLocale('en');
    });
    screen.rerender(wrapped());
    await settle();

    expect(screen.get('notes.list.title').props['children']).toBe('Notes');
  });
});
