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
import { NOTES_TABLE, notesModule } from '@bolusi/modules/notes';
import type { NoteSyncStatuses, NotesRuntime } from '@bolusi/modules/notes/screens';
import {
  bindModulePort,
  type CommandIdentity,
  type InvalidationBus,
  type ModuleRuntime,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';

export interface NotesRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  /** Per-note op statuses (design-system §3.5), read from the op log (`readEntitySyncStatuses`). */
  readonly noteSyncStatuses: (noteIds: readonly string[]) => Promise<NoteSyncStatuses>;
  /** Task-82 capture flow, resolved to the attached media id (or null on cancel). */
  readonly capturePhoto: NotesRuntime['capturePhoto'];
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
export function createNotesRuntime(deps: NotesRuntimeDeps): NotesRuntime {
  const port = bindModulePort(notesModule, deps.runtime, deps.identity);
  return {
    listNotes: (input) => port.query('listNotes', input),
    getNote: (input) => port.query('getNote', input),
    createNote: (input) => port.run('createNote', input),
    editNoteBody: (input) => port.run('editNoteBody', input),
    archiveNote: (input) => port.run('archiveNote', input),
    noteSyncStatuses: deps.noteSyncStatuses,
    subscribe: (listener) => deps.invalidation.subscribeTable(NOTES_TABLE, listener),
    hasPermission: port.hasPermission,
    capturePhoto: deps.capturePhoto,
    loadThumbnail: deps.loadThumbnail,
  };
}
