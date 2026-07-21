// The `notes` module's queries (04 §6): `listNotes` (cursor pagination + archived filter) and
// `getNote`, both gated by `notes.read`.
//
// Both scope every read to `qctx.tenantId` + `qctx.storeId` — which the runtime minted — and NEVER
// to anything in the input or the cursor (query/cursor.ts: a cursor is a POSITION, not an
// AUTHORIZATION). A caller who hand-edits a cursor moves their own position within rows they were
// already entitled to; they cannot name a tenant or a store. The permission check runs at the
// shared enforcement point BEFORE the handler (04 §6 step 2), so a zero-grant caller gets an
// explicit `PERMISSION_DENIED`, never `{ rows: [] }` (FR-1036) — that denial is proven at the
// runtime level, not here.
//
// These run on the CLIENT (SQLite), which is where the v0 query layer drives the UI (04 §2). The
// `archived` column is `0/1` there (schema.ts); a v1 server-reporting reader would be a separate
// concern (04 §2 — "future reporting").
import { z } from 'zod';

import {
  decodeCursor,
  DomainError,
  encodeCursor,
  type QueryContext,
  type QueryPage,
} from '@bolusi/core';

import { NOTE_ENTITY, NOTES_PERMISSION } from './constants.js';
import type { NotesDatabase } from './schema.js';

/** Sort options (04 §6). The `id` tiebreaker is implicit — see the cursor construction below. */
export type NoteSort = 'createdAt.desc' | 'createdAt.asc';

/**
 * `listNotes` input (04 §6).
 *
 * `limit`'s `.max(100)` is the SCHEMA's job, not the handler's: `limit > 100` is `VALIDATION_FAILED`
 * at execute step 1 and the handler never runs, so a caller cannot ask for 10,000 rows and have the
 * handler quietly clamp it.
 *
 * `filter.archived` is the "Show archived" toggle (ui-labels `notes.filter.showArchived`): absent or
 * `false` ⇒ the active list (archived excluded); `true` ⇒ archived notes are included alongside
 * active ones. Archived notes are excluded by default and included with the filter (01 §9 / 04 §8).
 */
export const listNotesInput = z
  .object({
    filter: z.object({ archived: z.boolean().optional() }).strict().optional(),
    sort: z.enum(['createdAt.desc', 'createdAt.asc']).default('createdAt.desc'),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListNotesInput = z.infer<typeof listNotesInput>;

/** A `listNotes` / `getNote` row (01 §9). Business fields only; scope stays in `qctx`. */
export interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly mediaId: string | null;
  /**
   * The SIGNED hash of the attachment (v3 payloads only — 06 §6). The render path verifies fetched
   * bytes against THIS before display; `null` means the note predates v3 and is resolvable only from
   * a local file, never fetched-and-claimed-verified.
   */
  readonly mediaSha256: string | null;
  readonly mediaMime: string | null;
  readonly archived: boolean;
  readonly editCount: number;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly lastEditedBy: string;
  readonly lastEditedAt: number;
}

/** Normalize the stored `archived` (`0/1` on SQLite, `true/false` on Postgres) to a JS boolean. */
function toBool(value: number | boolean): boolean {
  return value === 1 || value === true;
}

const NOTE_COLUMNS = [
  'id',
  'title',
  'body',
  'mediaId',
  'mediaSha256',
  'mediaMime',
  'archived',
  'editCount',
  'createdBy',
  'createdAt',
  'lastEditedBy',
  'lastEditedAt',
] as const;

function toRow(row: {
  id: string;
  title: string;
  body: string;
  mediaId: string | null;
  mediaSha256: string | null;
  mediaMime: string | null;
  archived: number | boolean;
  editCount: number;
  createdBy: string;
  createdAt: number;
  lastEditedBy: string;
  lastEditedAt: number;
}): NoteRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    mediaId: row.mediaId,
    mediaSha256: row.mediaSha256,
    mediaMime: row.mediaMime,
    archived: toBool(row.archived),
    editCount: row.editCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lastEditedBy: row.lastEditedBy,
    lastEditedAt: row.lastEditedAt,
  };
}

export async function listNotesHandler(
  input: ListNotesInput,
  qctx: QueryContext<NotesDatabase>,
): Promise<QueryPage<NoteRow>> {
  const descending = input.sort === 'createdAt.desc';
  const includeArchived = input.filter?.archived === true;

  let query = qctx.db
    .selectFrom('notes')
    .select([...NOTE_COLUMNS])
    // Scope from `qctx` (runtime-minted), never from input/cursor — what makes an unsigned cursor
    // safe. A note is store-scoped with a non-null store (01 §9), so this is a plain equality.
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .orderBy('createdAt', descending ? 'desc' : 'asc')
    // The `id` tiebreaker makes the order TOTAL. Without it two notes sharing a createdAt have no
    // defined relative order, and a page boundary between them drops or repeats one.
    .orderBy('id', descending ? 'desc' : 'asc');

  if (!includeArchived) {
    // Active list: exclude archived. `0` (not `false`) — the client column is INTEGER and op-sqlite
    // refuses a boolean bind (schema.ts).
    query = query.where('archived', '=', 0);
  }

  if (input.cursor !== undefined) {
    const position = decodeCursor(input.cursor, input.sort);
    const [lastCreatedAt, lastId] = position.values as [number, string];
    query = query.where((eb) =>
      eb.or([
        eb('createdAt', descending ? '<' : '>', lastCreatedAt),
        eb.and([eb('createdAt', '=', lastCreatedAt), eb('id', descending ? '<' : '>', lastId)]),
      ]),
    );
  }

  // One MORE than asked: how "is there a next page?" is answered without a second COUNT, and what
  // makes the last page's `nextCursor` null rather than a cursor that yields an empty page (04 §6).
  const found = await query.limit(input.limit + 1).execute();
  const hasMore = found.length > input.limit;
  const page = hasMore ? found.slice(0, input.limit) : found;

  const rows = page.map(toRow);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ sort: input.sort, values: [last.createdAt, last.id] })
      : null;

  return { rows, nextCursor };
}

/**
 * The `listNotes` declaration (04 §6).
 *
 * `name` is carried on the const itself — not only attached by `defineModule` from the manifest key
 * — so this object is a complete `ExecutableQuery` usable through `ctx.query` (the query runtime
 * needs the name for a denial op's `target`, 02 §7). `defineModule` re-attaches the same name.
 */
export const listNotesQuery = {
  name: 'listNotes',
  permission: NOTES_PERMISSION.read,
  input: listNotesInput,
  handler: listNotesHandler,
} as const;

// ── getNote ──────────────────────────────────────────────────────────────────────────────────

export const getNoteInput = z.object({ noteId: z.string().min(1) }).strict();

export type GetNoteInput = z.infer<typeof getNoteInput>;

/**
 * Read one note (04 §6). Returns the row as a single-element page, or throws `ENTITY_NOT_FOUND` —
 * "getNote returns the row or ENTITY_NOT_FOUND" (04 §8). It is the read seam the `editNoteBody` /
 * `archiveNote` commands use (04 §5.2: reads only via `ctx.query`), so a nonexistent note surfaces
 * as `ENTITY_NOT_FOUND` at both the query and the command, from ONE definition (CLAUDE.md §2.8).
 *
 * @throws {DomainError} `ENTITY_NOT_FOUND` — no such note in the caller's scope.
 */
export async function getNoteHandler(
  input: GetNoteInput,
  qctx: QueryContext<NotesDatabase>,
): Promise<QueryPage<NoteRow>> {
  const row = await qctx.db
    .selectFrom('notes')
    .select([...NOTE_COLUMNS])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('id', '=', input.noteId)
    .executeTakeFirst();

  if (row === undefined) {
    throw new DomainError(
      'ENTITY_NOT_FOUND',
      { entityType: NOTE_ENTITY, entityId: input.noteId },
      `no note ${input.noteId} is visible in this scope`,
    );
  }

  return { rows: [toRow(row)], nextCursor: null };
}

/**
 * The `getNote` declaration (04 §6). Carries its own `name` so `editNoteBody` / `archiveNote` can
 * read through it via `ctx.query` (the query runtime needs the name; 02 §7). One object, referenced
 * as both the manifest query AND the command's read seam (CLAUDE.md §2.8).
 */
export const getNoteQuery = {
  name: 'getNote',
  permission: NOTES_PERMISSION.read,
  input: getNoteInput,
  handler: getNoteHandler,
} as const;
