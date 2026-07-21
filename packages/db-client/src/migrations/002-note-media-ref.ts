// Client schema, migration 2 — the signed media hash/mime on `notes` (task 120).
//
// WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO 001. runner.ts states the rule outright: "Append
// new ones; never rewrite a shipped one." 001 carries one in-place edit (task 76's user_prefs
// default) justified by SQLite having no `ALTER COLUMN DROP DEFAULT` — that escape hatch does not
// apply here, because `ALTER TABLE ... ADD COLUMN` is exactly what SQLite DOES support. So this is
// an ordinary appended migration.
//
// WHY THE COLUMNS EXIST (06 §6 + 05 §2). A `notes.note_created` payload at schemaVersion 2 carried
// only `mediaId`. That is enough for a note whose photo THIS device captured — it resolves through
// `media_items.local_path`. It is not enough for a note PULLED from another device: 06 §6 requires
// the fetched bytes be "verified against `mediaRef.sha256` before display", and a pulled note has no
// `media_items` row to read a hash from. schemaVersion 3 therefore carries the whole signed
// `mediaRef` in the op payload — the only tamper-evident copy (05 §2: the payload is what the
// Ed25519 signature covers) — and these two columns are where the fold lands it.
//
// NULLABLE, deliberately: v1 notes have no media and v2 notes have a `mediaId` with no signed hash.
// Both are legitimate history that never disappears (05 §7), so the columns are honestly empty for
// them rather than back-filled with a value nobody signed.
import type { ClientMigration } from './types.js';

export const noteMediaRefMigration: ClientMigration = {
  version: 2,
  name: 'note_media_ref',
  statements: [
    `ALTER TABLE notes ADD COLUMN media_sha256 TEXT`,
    `ALTER TABLE notes ADD COLUMN media_mime TEXT`,
  ],
};
