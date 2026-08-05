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
  fire,
  harnessRuntime,
  NotesRuntimeProvider,
  openHarness,
  page,
  remoteNoteCreated,
  render,
  renderNotes,
  textsIn,
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

  test('empty WITH create permission → EXACTLY ONE create primary: the EmptyState CTA, not two (§3.1)', async () => {
    const screen = mount(
      fakeRuntime({ hasPermission: () => true, listNotes: () => Promise.resolve(page([])) }),
    );
    await settle();

    expect(screen.query('notes.list.items.empty')).not.toBeNull();
    expect(screen.query('ui.emptyState.cta')).not.toBeNull(); // the create CTA lives here on empty
    // …and the persistent bottom-action create is SUPPRESSED, so there is ONE primary, not two
    // (§3.1, item 2). Restore the old always-on `bottomAction` and this goes non-null → red.
    expect(screen.query('notes.list.create')).toBeNull();
  });

  test('non-empty WITH create → the bottom-action create IS the one primary (empty CTA absent)', async () => {
    // The other half of §3.1: with rows there is no EmptyState, so the persistent create button is
    // the single primary. Real rows via the harness (a full NoteRow is 12 fields); gate the button
    // off (the item-2 bug direction) and this goes null → red.
    h = await openHarness(5);
    const rt = harnessRuntime(h, h.notesUserId);
    await rt.createNote({ title: 'Ada', body: '', mediaRef: null });

    const screen = mount(rt);
    await settle();

    expect(screen.query('notes.list.create')).not.toBeNull();
    expect(screen.query('ui.emptyState.cta')).toBeNull();
  });

  test('ARCHIVED-empty offers NO create CTA (a "new note" here would be an invisible active note, item 2)', async () => {
    const screen = mount(
      fakeRuntime({ hasPermission: () => true, listNotes: () => Promise.resolve(page([])) }),
    );
    await settle();
    // Enter the archived view.
    fire(screen.get('notes.list.archivedToggle'), 'onPress');
    await settle();

    expect(screen.query('notes.list.items.empty')).not.toBeNull();
    // The LOAD-BEARING assertion here: remove the `if (showArchived)` archived-empty branch and the
    // active-empty CTA reappears → non-null → red. (The `notes.list.create` check below is a belt:
    // it is inert against the `!showArchived` bottomAction clause specifically, because `hasRows` is
    // already false on empty — that clause is falsified by the archived-ROWS test that follows.)
    expect(screen.query('ui.emptyState.cta')).toBeNull();
    expect(screen.query('notes.list.create')).toBeNull();
  });

  test('ARCHIVED view WITH rows offers NO create — the `!showArchived` bottomAction clause (item 2)', async () => {
    // The only state where `!showArchived` is load-bearing: with rows, `hasRows` is true, so ONLY the
    // `!showArchived` clause keeps the create primary out of the archived view. Seed a real archived
    // note (create → archive), toggle to archived, assert the row shows but create does not. Drop
    // `!showArchived` from the bottomAction gate and `notes.list.create` goes non-null → red.
    h = await openHarness(6);
    const rt = harnessRuntime(h, h.notesUserId);
    const { noteId } = await rt.createNote({ title: 'Lama', body: '', mediaRef: null });
    await rt.archiveNote({ noteId });

    const screen = mount(rt);
    await settle();
    fire(screen.get('notes.list.archivedToggle'), 'onPress');
    await settle();

    expect(screen.query(`notes.list.row.${noteId}`)).not.toBeNull(); // it IS an archived row
    expect(screen.query('notes.list.create')).toBeNull(); // …and create is suppressed here
  });

  test('the archived toggle signals state by its LABEL, not colour only (§6.3, item 3)', async () => {
    const screen = mount(
      fakeRuntime({ hasPermission: () => true, listNotes: () => Promise.resolve(page([])) }),
    );
    await settle();

    const before = textsIn(screen.get('notes.list.archivedToggle'));
    fire(screen.get('notes.list.archivedToggle'), 'onPress');
    await settle();
    const after = textsIn(screen.get('notes.list.archivedToggle'));

    // The label RESPONDS to state (structure, not a hardcoded copy string, T-4): a colour-only
    // toggle renders the same word in both, so `before` would equal `after` → red.
    expect(before).not.toEqual(after);
    expect(before.join('')).not.toBe('');
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
    // design-system §5: an Unauthorized state carries the "ask your store owner" GUIDANCE body, not
    // a bare title. The `List` gives its UnauthorizedState no explicit testID, so the hint is the
    // component default `ui.unauthorizedState.hint`. Drop the screen's `hint` prop and it goes
    // null → red (129 item 9); one denial state in this tree, so the id is unambiguous.
    expect(screen.query('ui.unauthorizedState.hint')).not.toBeNull();
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
