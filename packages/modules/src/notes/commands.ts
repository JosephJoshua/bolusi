// The `notes` module's commands (04 §5) — the only write path: `createNote`, `editNoteBody`,
// `archiveNote`. Each is PURE (04 §5.2): no clock, no db, no network, no nested commands. Reads go
// through `ctx.query` — the SAME query layer the UI uses — which is a handler's only read seam. The
// runtime stamps the timestamp, completes the envelope, appends and projects (04 §5.1 steps 4–6);
// a handler returns op drafts + an optional typed result and nothing else.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import { NOTE_ENTITY, NOTES_OP } from './constants.js';
import { getNoteQuery } from './queries.js';

// ── createNote ─────────────────────────────────────────────────────────────────────────────────

/**
 * `createNote` input (04 §5).
 *
 * `title.min(1)` makes an empty title `VALIDATION_FAILED` at execute step 1 — the handler never
 * runs, nothing is appended. `mediaId` is `.nullable().default(null)` so the emitted op's payload
 * always carries it present-and-null (05 §3): a note created without a photo still records the
 * v2 shape, so v1 vs v2 is a property of the op's `schemaVersion`, never of which keys are present.
 * `.strict()` rejects an unknown key.
 */
export const createNoteInput = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    mediaId: z.string().nullable().default(null),
  })
  .strict();

export type CreateNoteInput = z.infer<typeof createNoteInput>;

/**
 * Create a note. Mints a fresh entity id (`ctx.newId()` — UUIDv7) and emits a v2 `note_created`
 * whose payload carries the `mediaId` (04 §8 media-attach: the op syncs/applies independently of the
 * media upload — the projection just records the id). No read needed: a create has no precondition.
 */
export function createNoteHandler(
  input: CreateNoteInput,
  ctx: CommandContext,
): CommandHandlerResult<{ noteId: string }> {
  const noteId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: NOTES_OP.noteCreated,
        entityType: NOTE_ENTITY,
        entityId: noteId,
        // v2 payload (mediaId present-and-null). The runtime resolves schemaVersion 2 from the
        // registry (ctx.ts) — a handler may not state its own version.
        payload: { title: input.title, body: input.body, mediaId: input.mediaId },
      }),
    ],
    result: { noteId },
  };
}

// ── editNoteBody ───────────────────────────────────────────────────────────────────────────────

export const editNoteBodyInput = z.object({ noteId: z.string().min(1), body: z.string() }).strict();

export type EditNoteBodyInput = z.infer<typeof editNoteBodyInput>;

/**
 * Edit a note's body. Reads the note through the query layer (the only read seam, 04 §5.2):
 * `getNote` throws `ENTITY_NOT_FOUND` for a nonexistent id, which propagates here unchanged — one
 * definition of "no such note" (CLAUDE.md §2.8).
 *
 * Editing a note that is archived IN THE LOCAL PROJECTION is a command-level denial (01 §9):
 * `INVALID_TRANSITION`, not a projection rule. The CONCURRENT case — an edit appended by a device
 * that had not yet seen the archive — is NOT caught here (that device's projection does not show the
 * note archived); it is flagged server-side by the Rule-2 check `notes:edit_after_archive`
 * (conflict-checks.ts). The two are different questions and only the second one is a Conflict.
 *
 * @throws {DomainError} `ENTITY_NOT_FOUND` — no such note; `INVALID_TRANSITION` — the note is
 *   archived (03 §12 details shape `{machine, from, event, entityId}`).
 */
export async function editNoteBodyHandler(
  input: EditNoteBodyInput,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ noteId: string }>> {
  const page = await ctx.query(getNoteQuery, { noteId: input.noteId });
  const note = page.rows[0];
  // getNote throws ENTITY_NOT_FOUND when absent, so `note` is defined here — this is defence in
  // depth, not a second not-found path.
  if (note === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: NOTE_ENTITY, entityId: input.noteId },
      `no note ${input.noteId} is visible in this scope`,
    );
  }
  if (note.archived) {
    throw new DomainError(
      'INVALID_TRANSITION',
      { machine: 'note', from: 'archived', event: NOTES_OP.noteBodyEdited, entityId: input.noteId },
      `note ${input.noteId} is archived; an archived note cannot be edited (01 §9)`,
    );
  }

  return {
    ops: [
      ctx.op({
        type: NOTES_OP.noteBodyEdited,
        entityType: NOTE_ENTITY,
        entityId: input.noteId,
        payload: { body: input.body },
      }),
    ],
    result: { noteId: input.noteId },
  };
}

// ── archiveNote ────────────────────────────────────────────────────────────────────────────────

export const archiveNoteInput = z.object({ noteId: z.string().min(1) }).strict();

export type ArchiveNoteInput = z.infer<typeof archiveNoteInput>;

/**
 * Archive a note. Archived is TERMINAL (01 §9: no unarchive in v0), so archiving an already-archived
 * note is `INVALID_TRANSITION` — refused rather than emitting an op guaranteed to fold into no
 * change (which would append a permanent, signed, synced no-op to an append-only log; the same
 * reason `acknowledgeConflict` refuses a non-surfaced conflict).
 *
 * @throws {DomainError} `ENTITY_NOT_FOUND` — no such note; `INVALID_TRANSITION` — already archived.
 */
export async function archiveNoteHandler(
  input: ArchiveNoteInput,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ noteId: string }>> {
  const page = await ctx.query(getNoteQuery, { noteId: input.noteId });
  const note = page.rows[0];
  if (note === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: NOTE_ENTITY, entityId: input.noteId },
      `no note ${input.noteId} is visible in this scope`,
    );
  }
  if (note.archived) {
    throw new DomainError(
      'INVALID_TRANSITION',
      { machine: 'note', from: 'archived', event: NOTES_OP.noteArchived, entityId: input.noteId },
      `note ${input.noteId} is already archived; archive is terminal (01 §9)`,
    );
  }

  return {
    ops: [
      ctx.op({
        type: NOTES_OP.noteArchived,
        entityType: NOTE_ENTITY,
        entityId: input.noteId,
        payload: {},
      }),
    ],
    result: { noteId: input.noteId },
  };
}
