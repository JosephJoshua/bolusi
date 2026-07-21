// The `notes` module's operation registry (04 §3; 01 §9 is the authoritative type list).
//
// Three types, all store-scoped (the default — a note belongs to one store, 01 §9), all with
// MANDATORY `reversal` prose (04 §3 / 05 §7). Only `note_body_edited` declares a `conflict`: two
// devices editing one note's body is the v0 minor-conflict case (01 §8.1/§8.3). `note_created` and
// `note_archived` declare none — creation is not a collision, and archive is terminal, so the
// concurrent-edit-after-archive case is a Rule-2 invariant check (conflict-checks.ts), not a Rule-1
// same-key collision.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zMediaRef } from '@bolusi/schemas';

import { noteArchivedApplier, noteBodyEditedApplier, noteCreatedApplier } from './applier.js';
import { NOTE_BODY_CONFLICT_KEY, NOTE_CREATED_SCHEMA_VERSION, NOTES_OP } from './constants.js';
import type { NotesDatabase } from './schema.js';

/**
 * `notes.note_created` payload — the CURRENT version (v3, 01 §9): `{title, body, mediaRef}`.
 *
 * The registry carries ONE schema per op type, the current one, and every freshly-emitted op is v3.
 * v1 (`{title, body}`) and v2 (`{title, body, mediaId}`) payloads live only in history and are never
 * re-validated — the server validates ONLY new pushes, which are always v3 (05 §7).
 *
 * ── WHY v3 EXISTS: THE HASH MUST TRAVEL WITH THE SIGNATURE (05 §2, 06 §6) ──────────────────────
 *
 * v2's `mediaId` is sufficient for a note whose photo THIS device captured: the id resolves through
 * `media_items.local_path`. It is NOT sufficient for a note PULLED from another device. 06 §6
 * requires fetched bytes be "verified against `mediaRef.sha256` before display", and a pulled note
 * has no `media_items` row to source a hash from — so a remote note's photo could not be
 * download-verified at all. 05 §2 settles where the hash belongs: `payload` is inside the signed
 * core, so the payload is the ONE tamper-evident carrier this system has. Anything the receiving
 * device must TRUST has to ride in it. Hence v3.
 *
 * ── WHY ONE NESTED OBJECT AND NOT THREE SIBLING FIELDS ─────────────────────────────────────────
 *
 * `mediaRef` is a single nullable object, NOT `mediaId` + `sha256` + `mime` alongside each other.
 * With siblings, "media attached, but no signed hash" is a representable payload — the exact defect
 * v3 exists to close, re-admitted through the schema that was supposed to close it (CLAUDE.md §2.11:
 * a guard whose failure mode is "silently permits the thing" is worse than none). Nested, that state
 * has no inhabitant: either there is no attachment (`null`), or there is a COMPLETE one. The
 * compiler and Zod both enforce it, so it cannot be forgotten at a call site.
 *
 * It reuses `zMediaRef` from `@bolusi/schemas` rather than declaring a narrower `{mediaId, sha256,
 * mime}` here, on two counts. (1) 06 §3.2 defines `mediaRef` as THE shared payload fragment "any
 * module payload that attaches media embeds — never redefine per module" (CLAUDE.md §2.8); a
 * three-field local subset would be precisely that forbidden redefinition. (2) 06 §3.1 wants the
 * immutable capture metadata (`capturedAt`, `location`, `userId`, `deviceId`) bound by the same
 * signature — that binding IS the "embedded metadata" of FR-816, and dropping the fields here would
 * quietly discard it.
 *
 * `.nullable()`, never `.optional()` — 05 §3's absent-vs-null rule: the JCS preimage has no optional
 * keys, so a no-photo note carries `mediaRef: null` explicitly. `zMediaRef` states the same rule for
 * its own fields.
 */
export const noteCreatedPayload = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    mediaRef: zMediaRef.nullable(),
  })
  .strict();

/** `notes.note_body_edited` payload (01 §9): `{body}`. */
export const noteBodyEditedPayload = z.object({ body: z.string() }).strict();

/** `notes.note_archived` payload (01 §9): `{}` — archiving carries no data; `.strict()` rejects any. */
export const noteArchivedPayload = z.object({}).strict();

/** The three `notes` op declarations (04 §3), keyed by op type. */
export const notesOperations: Readonly<Record<string, OperationDeclaration<NotesDatabase>>> = {
  [NOTES_OP.noteCreated]: {
    // v3 (01 §9): the mid-history schema bumps the exit criteria require (04 §8). The applier folds
    // v1, v2 AND v3 forever (applier.ts) — old ops never disappear (05 §7).
    schemaVersion: NOTE_CREATED_SCHEMA_VERSION,
    payload: noteCreatedPayload,
    reversal:
      'Reversed by notes.note_archived on the same entityId (04 §3 / 05 §7) — a note is not deleted, it is archived (01 §9: no hard delete, archive is terminal). v0 keeps this as documentation; an executable buildReversal slots in for V2.',
    apply: noteCreatedApplier,
    // No `conflict`: two devices creating a note mint two DIFFERENT entities (fresh entityId each),
    // so there is nothing to collide on. Store-scoped by default (01 §9).
  },

  [NOTES_OP.noteBodyEdited]: {
    schemaVersion: 1,
    payload: noteBodyEditedPayload,
    reversal:
      'Reversed by a subsequent notes.note_body_edited carrying the previous body (04 §3 / 05 §7). The earlier body survives in the append-only log even after the projection shows the later one (01 §8.3: the losing author’s text is never lost).',
    apply: noteBodyEditedApplier,
    // 01 §8.1: two accepted body edits on one note collide on `note.body`. minor (01 §8.3):
    // canonical-order LWW already produced a nothing-lost outcome; recorded for reporting, surfaced
    // to nobody. The server's Rule-1 detection keys off this declaration.
    conflict: { key: NOTE_BODY_CONFLICT_KEY, severity: 'minor' },
  },

  [NOTES_OP.noteArchived]: {
    schemaVersion: 1,
    payload: noteArchivedPayload,
    reversal:
      'NOT reversible in v0 (01 §9: archive is terminal, there is no unarchive). Recorded because 04 §3 makes reversal MANDATORY: the honest answer is "there is no undo", and stating it is the point. Unarchive is roadmap.',
    apply: noteArchivedApplier,
    // No `conflict`: archive is terminal and idempotent, so two archives of one note are a
    // sequence, not a collision. The edit-after-archive case is Rule-2 (conflict-checks.ts).
  },
};
