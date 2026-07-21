/**
 * PRODUCTION-PATH proof for task 122 — the notes module i18n catalog resolves because the REAL app
 * boot registered it, NOT because a test-support file did.
 *
 * ── WHY THIS FILE DELIBERATELY DOES NOT TOUCH notes-support.tsx (CLAUDE.md §2.11) ────────────────
 * `apps/mobile/test/notes-support.tsx` calls `registerNotesCatalog` in its own setup, so every test
 * built on it resolves `notes.*` regardless of what the shipping app does — the exact blind spot this
 * task exists to close ("a test that uses the test-support wiring PROVES NOTHING here"). Even task
 * 119's `live-shell-notes.test.tsx` is fed by it: `mountRoot` calls `ensureNotesCatalog()`. So this
 * file drives the PRODUCTION i18n boot (`bootstrapI18n` — the function `Root`/`index.ts` run on
 * native) and asserts a SHIPPING screen renders Indonesian chrome. Remove the production registration
 * and these go RED; that red is the whole point (the ~600 green tests could not see the defect).
 *
 * The device locale defaults to `id` (07-i18n §1.2): the injected store returns null, so the app
 * renders in Indonesian — the state an Indonesian-first shop actually boots into.
 */
import { t, type TranslationKey } from '@bolusi/i18n';
import { NotesList, NotesRuntimeProvider, type NotesRuntime } from '@bolusi/modules/notes/screens';
import { act } from 'react';
import { describe, expect, test } from 'vitest';

import { render, textsIn } from '../../../packages/ui/test/render.js';

import { bootstrapI18n } from '../src/i18n.js';

/** The pre-login device-locale store (§1.2): unset ⇒ default `id`. */
const idDeviceStore = { read: () => Promise.resolve(null), write: () => Promise.resolve() };

/**
 * A `notes.*` key routed exactly as a screen routes it: `tn` (the module translate) wraps this same
 * `t`, so if `t('notes.list.title')` resolves to the catalog value, every screen does too. The cast
 * is the module-namespace escape hatch — `t`'s union is the reserved catalogs, which by design
 * exclude module namespaces (07-i18n §3.3/§3.4).
 */
function tNotes(key: string): string {
  return t(key as unknown as TranslationKey);
}

/** A minimal `NotesRuntime` — enough for `NotesList` to render its chrome; no test-support import. */
const fakeRuntime: NotesRuntime = {
  listNotes: () => Promise.resolve({ rows: [], nextCursor: null }),
  getNote: () => Promise.resolve({ rows: [], nextCursor: null }),
  createNote: () => Promise.resolve({ noteId: 'n' }),
  editNoteBody: () => Promise.resolve({ noteId: 'n' }),
  archiveNote: () => Promise.resolve({ noteId: 'n' }),
  noteSyncStatuses: () => Promise.resolve({}),
  subscribe: () => () => undefined,
  hasPermission: () => true,
  capturePhoto: () => Promise.resolve(null),
  loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
};

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

describe('the REAL app boot registers the notes module catalog (task 122)', () => {
  test('the production i18n boot resolves notes.* to the shipped Indonesian catalog', async () => {
    const applied = await bootstrapI18n(idDeviceStore);
    expect(applied).toBe('id');

    // Without the production registration these fall back to the humanized key leaf — "Title",
    // "Show archived", "New" — which is exactly the English chrome task 116's screenshot caught.
    expect(tNotes('notes.list.title')).toBe('Catatan');
    expect(tNotes('notes.filter.showArchived')).toBe('Tampilkan arsip');
    expect(tNotes('notes.action.new')).toBe('Catatan Baru');
  });

  test('a shipping NotesList renders Indonesian chrome after the production boot', async () => {
    await bootstrapI18n(idDeviceStore);

    const screen = render(
      <NotesRuntimeProvider runtime={fakeRuntime}>
        <NotesList
          now={0}
          syncChip={null}
          avatar={null}
          onOpenNote={() => undefined}
          onCreateNote={() => undefined}
          onOpenSyncStatus={() => undefined}
        />
      </NotesRuntimeProvider>,
    );
    await settle();

    const texts = textsIn(screen.get('notes.list'));
    // The three chrome strings the screenshot must show — the list header, the archive filter, and
    // the create CTA — in Indonesian, not the English key fallback.
    expect(texts).toContain('Catatan');
    expect(texts).toContain('Tampilkan arsip');
    expect(texts).toContain('Catatan Baru');
    // And the English fallbacks are ABSENT — the denominator that makes the assertion mean something.
    expect(texts).not.toContain('Title');
    expect(texts).not.toContain('New');
  });
});
