/**
 * Bind a `NotesRuntime` (the screens' 04 §7 port) over the composed `ModuleRuntime` — the reference
 * wiring every future module screen copies. Identity-scoped: one `CommandContext` per user, queries
 * executed with that identity so a denial throws `PERMISSION_DENIED` (never `[]`), and live-query
 * invalidation subscribed to the notes projection table (04 §7).
 *
 * The media + op-status seams are injected rather than reached for here, because their sources differ
 * from the command/query runtime (the media client; the op-log bookkeeping) and keeping them as
 * parameters is what lets a test drive the SAME screens over a real runtime with fake media.
 */
import { NOTE_ENTITY, NOTES_TABLE, notesModule } from '@bolusi/modules/notes';
import type { CapturedMedia, NoteSyncStatuses, NotesRuntime } from '@bolusi/modules/notes/screens';
import type { CommandIdentity, CommandOutcome, InvalidationBus, ModuleRuntime } from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import type { OperationSyncStatus } from '@bolusi/ui';
import type { Kysely } from 'kysely';

export interface NotesRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  /** Per-note op statuses (design-system §3.5) — read from the op log, see `readNoteSyncStatuses`. */
  readonly noteSyncStatuses: (noteIds: readonly string[]) => Promise<NoteSyncStatuses>;
  /** Task-82 capture flow, resolved to the attached media id (or null on cancel). */
  readonly capturePhoto: () => Promise<CapturedMedia | null>;
  /**
   * Media client's verified thumbnail (06 §6).
   *
   * DERIVED FROM THE PORT, not restated: the argument is a `ThumbnailRef`, which carries the SIGNED
   * sha256/mime for a v3 note and only an id for a legacy v1/v2 one. Re-declaring the signature here
   * would let this file keep compiling against a stale shape while the port moved underneath it.
   */
  readonly loadThumbnail: NotesRuntime['loadThumbnail'];
}

/** `CommandRuntime.execute` returns `{ ops, result, timestamp }`; the screens want the typed result. */
async function resultOf<T>(outcome: Promise<CommandOutcome<T>>): Promise<T> {
  const settled = await outcome;
  if (settled.result === undefined) {
    throw new Error('command returned no result (04 §5.1) — a handler must return one');
  }
  return settled.result;
}

export function createNotesRuntime(deps: NotesRuntimeDeps): NotesRuntime {
  const ctx = deps.runtime.commands.createContext(deps.identity.userId);
  return {
    listNotes: (input) =>
      deps.runtime.queries.execute(notesModule.queries.listNotes, input, deps.identity),
    getNote: (input) =>
      deps.runtime.queries.execute(notesModule.queries.getNote, input, deps.identity),
    createNote: (input) =>
      resultOf(deps.runtime.commands.execute(notesModule.commands.createNote, input, ctx)),
    editNoteBody: (input) =>
      resultOf(deps.runtime.commands.execute(notesModule.commands.editNoteBody, input, ctx)),
    archiveNote: (input) =>
      resultOf(deps.runtime.commands.execute(notesModule.commands.archiveNote, input, ctx)),
    noteSyncStatuses: deps.noteSyncStatuses,
    subscribe: (listener) => deps.invalidation.subscribeTable(NOTES_TABLE, listener),
    hasPermission: (permissionId) =>
      deps.runtime.commands.enforcementPoint.hasPermission(deps.identity, permissionId),
    capturePhoto: deps.capturePhoto,
    loadThumbnail: deps.loadThumbnail,
  };
}

/**
 * Read each note's op sync statuses from the op log (design-system §3.5 — the projection row carries
 * no op status). A note with no rows is all-`synced` (absent from the map ⇒ the silent chip).
 */
export async function readNoteSyncStatuses(
  db: Kysely<ClientDatabase>,
  noteIds: readonly string[],
): Promise<NoteSyncStatuses> {
  if (noteIds.length === 0) return {};
  const rows = await db
    .selectFrom('operations')
    .select(['entityId', 'syncStatus'])
    .where('entityType', '=', NOTE_ENTITY)
    .where('entityId', 'in', [...noteIds])
    .execute();
  const out: Record<string, OperationSyncStatus[]> = {};
  for (const row of rows) {
    (out[row.entityId] ??= []).push(row.syncStatus as OperationSyncStatus);
  }
  return out;
}
