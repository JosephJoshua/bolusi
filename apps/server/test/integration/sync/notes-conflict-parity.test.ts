// THE cross-package guard for the `notes:edit_after_archive` Rule-2 declaration (01 §8.2;
// CLAUDE.md §2.8/§2.11 — comment-as-guard).
//
// `packages/modules/src/notes/conflict-checks.ts` declares `notesEditAfterArchive` — the MODULE's
// statement of the check's name/appliesTo/conflictKey/severity — and its header cites THIS file as
// the thing that keeps it identical to the server's authoritative `NOTES_EDIT_AFTER_ARCHIVE`
// (task 17, conflict-detection.ts), which owns the log-query `fires()` implementation.
//
// Nothing else can enforce it: the module cannot import `apps/server` (a package→app edge), so the
// equality is only checkable HERE, where BOTH are importable (`apps/server` depends on
// `@bolusi/modules`). Without this test the two just happen to hold identical literals — drift the
// module's `EDIT_AFTER_ARCHIVE_KEY` and every module test + typecheck stays green while production
// emits conflicts keyed differently than the module's declared/oracle key, with no failing test
// (the exact §2.11 anti-pattern: a comment claiming a guarantee nothing backs).
//
// FALSIFICATION (§2.11): change either side's conflictKey/severity → the equality test goes RED;
// restore → green.
import { describe, expect, test } from 'vitest';

import { notesEditAfterArchive } from '@bolusi/modules/notes';

import { NOTES_EDIT_AFTER_ARCHIVE } from '../../../src/sync/conflict-detection.js';

describe('notes:edit_after_archive — module declaration mirrors the server registry (§2.8/§2.11)', () => {
  test('name / appliesTo / conflictKey / severity are field-for-field identical', () => {
    // The server's `InvariantCheck` additionally carries `fires()` (the log query it OWNS); this
    // asserts every field the MODULE declares matches, which is the whole of the mirror contract.
    expect(NOTES_EDIT_AFTER_ARCHIVE.name).toBe(notesEditAfterArchive.name);
    expect([...NOTES_EDIT_AFTER_ARCHIVE.appliesTo]).toStrictEqual([
      ...notesEditAfterArchive.appliesTo,
    ]);
    expect(NOTES_EDIT_AFTER_ARCHIVE.conflictKey).toBe(notesEditAfterArchive.conflictKey);
    expect(NOTES_EDIT_AFTER_ARCHIVE.severity).toBe(notesEditAfterArchive.severity);
  });

  test('the shared values are the v0 spec constants (T-14 denominator — equal-but-wrong is still wrong)', () => {
    // The equality test alone would pass if BOTH sides drifted to the same NEW value. Pinning the
    // spec constants (01 §8.2/§8.3) here means a coordinated-but-unreviewed drift still fails until
    // someone changes the spec first — the intended workflow (04 §8 / CLAUDE.md §4).
    expect(notesEditAfterArchive.name).toBe('notes:edit_after_archive');
    expect([...notesEditAfterArchive.appliesTo]).toStrictEqual(['notes.note_body_edited']);
    expect(notesEditAfterArchive.conflictKey).toBe('note.archived');
    expect(notesEditAfterArchive.severity).toBe('significant');
  });
});
