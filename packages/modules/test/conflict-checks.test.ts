// The `notes:edit_after_archive` Rule-2 declaration + predicate (01 §8.2 / 04 §8 conflict decls).
//
// The PRODUCTION detection is server-side and order-based (task 17's `NOTES_EDIT_AFTER_ARCHIVE`,
// apps/server/src/sync/conflict-detection.ts). This module owns the DECLARATION (name, appliesTo,
// conflictKey, static severity) and a pure predicate over folded state — the module-scale oracle the
// harness (task 26) and this suite assert against. The values mirror the server's on purpose, so the
// two cannot disagree about what the check IS.
import { describe, expect, test } from 'vitest';

import { editAfterArchiveConflict, notesEditAfterArchive } from '../src/notes/index.js';

describe('notes:edit_after_archive declaration (01 §8.2)', () => {
  test('declares the v0 Rule-2 check exactly (name, appliesTo, key, static significant severity)', () => {
    expect(notesEditAfterArchive).toStrictEqual({
      name: 'notes:edit_after_archive',
      appliesTo: ['notes.note_body_edited'],
      conflictKey: 'note.archived',
      severity: 'significant',
    });
  });
});

describe('editAfterArchiveConflict predicate (01 §8.2/§8.3)', () => {
  test('an edit whose note was archived by a canonically-earlier op → a SIGNIFICANT conflict', () => {
    expect(editAfterArchiveConflict({ archivedByEarlierOp: true })).toStrictEqual({
      conflictKey: 'note.archived',
      severity: 'significant',
    });
  });

  test('an edit on a note NOT archived earlier → no conflict', () => {
    expect(editAfterArchiveConflict({ archivedByEarlierOp: false })).toBeNull();
  });
});
