// The `notes` module's Rule-2 invariant declaration (01 §8.2) — `notes:edit_after_archive`.
//
// 01 §8.2 registers EXACTLY ONE Rule-2 check in v0: "an accepted `notes.note_body_edited` whose note
// is already archived at fold time (the editing device had not seen the archive) → `significant`".
// This file is the MODULE's platform-free statement of that check — its name, the op type it applies
// to, and the conflict key + static severity it records — plus a pure predicate over folded state
// that the module suite and the chaos harness (task 26) exercise.
//
// ── WHERE THE AUTHORITATIVE DETECTION LIVES, AND WHY THIS IS NOT A SECOND COPY (§2.8) ──────────
//
// The PRODUCTION detection runs server-side, inside the push transaction, and is owned by task 17
// (`apps/server/src/sync/conflict-detection.ts` → `NOTES_EDIT_AFTER_ARCHIVE`). It asks the OP LOG
// whether a `notes.note_archived` sorts canonically BEFORE this edit — NOT "is the note archived
// now" — because detection runs after the whole acceptance loop, so a device that edits then
// archives its OWN note in one batch would, under a naive "read archived" check, be reported as
// conflicting with itself (the exact case 01 §8.2's parenthetical excludes). The order-based
// formulation is correct wherever the naive one is and differs only where the naive one is wrong.
//
// This predicate therefore takes `archivedByEarlierOp` — "did a canonically-earlier archive land
// for this note" — NOT a bare "is it archived", so it AGREES with the order-based rule by
// construction. It does not re-implement detection (no DB, no log query, platform-free); it is the
// module's declaration of what the check MEANS, so the server's registry and this module cannot
// disagree about the check's name, key, or severity, and the harness has a pure oracle to assert
// against. The values below are identical to the server's `NOTES_EDIT_AFTER_ARCHIVE` on purpose.
import type { ConflictSeverity } from '@bolusi/core';

import { NOTES_OP } from './constants.js';

/** The conflict key a fired edit-after-archive records (distinct from `note.body`, 01 §8.2). */
export const EDIT_AFTER_ARCHIVE_KEY = 'note.archived' as const;

/**
 * The module's declaration of the `notes:edit_after_archive` Rule-2 check (01 §8.2).
 *
 * Mirrors the server's `InvariantCheck` metadata (name, `appliesTo`, `conflictKey`, `severity`) so
 * the two cannot drift on what the check is. The server owns the `fires()` implementation (the log
 * query); this is the module's contribution — the constants the check is built from.
 */
export interface EditAfterArchiveDeclaration {
  readonly name: 'notes:edit_after_archive';
  /** The op type this check runs for — nothing else pays its cost (01 §8.2). */
  readonly appliesTo: readonly [typeof NOTES_OP.noteBodyEdited];
  /** The conflict key recorded when it fires (01 §8.2). */
  readonly conflictKey: typeof EDIT_AFTER_ARCHIVE_KEY;
  /** Static per the type (01 §8.3): edit-after-archive is always `significant`. */
  readonly severity: Extract<ConflictSeverity, 'significant'>;
}

export const notesEditAfterArchive: EditAfterArchiveDeclaration = {
  name: 'notes:edit_after_archive',
  appliesTo: [NOTES_OP.noteBodyEdited],
  conflictKey: EDIT_AFTER_ARCHIVE_KEY,
  severity: 'significant',
};

/** A fired Rule-2 conflict: the key + static severity to record (01 §8.2/§8.3). */
export interface EditAfterArchiveHit {
  readonly conflictKey: typeof EDIT_AFTER_ARCHIVE_KEY;
  readonly severity: Extract<ConflictSeverity, 'significant'>;
}

/**
 * Does an accepted `notes.note_body_edited` break the edit-after-archive invariant (01 §8.2)?
 *
 * PURE — the module-scale oracle for the check. `archivedByEarlierOp` is "did a canonically-earlier
 * `notes.note_archived` land for this note" (the folded-state view the server's order query
 * answers). `true` ⇒ a `significant` conflict (the edit reached a note the editor had not seen
 * archived); `false` ⇒ no conflict (a plain edit). The server never REJECTS for this — it accepts
 * and flags (01 §8.2) — so this returns a hit to record, never a veto.
 */
export function editAfterArchiveConflict(input: {
  readonly archivedByEarlierOp: boolean;
}): EditAfterArchiveHit | null {
  if (!input.archivedByEarlierOp) return null;
  return { conflictKey: EDIT_AFTER_ARCHIVE_KEY, severity: 'significant' };
}
