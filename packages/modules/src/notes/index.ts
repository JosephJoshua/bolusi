// The `notes` reference module (04 §8) — PLATFORM-FREE public surface (08 §3.2).
//
// `apps/server`, `apps/mobile` and the chaos harness import the manifest and the data-layer types
// from HERE (`@bolusi/modules/notes`); the RN screens live behind `@bolusi/modules/notes/screens`
// and are owned by task 96 (the boundary rule keeps a server import off `*/screens`). Nothing in
// this file imports React or a platform module.
export { notesModule, notesModuleManifest } from './manifest.js';

export {
  NOTES_MODULE_ID,
  NOTE_ENTITY,
  NOTES_TABLE,
  NOTES_OP,
  NOTES_PERMISSION,
  NOTE_CREATED_SCHEMA_VERSION,
  NOTE_BODY_CONFLICT_KEY,
} from './constants.js';

export type { NotesDatabase, NotesTable } from './schema.js';

export {
  notesOperations,
  noteCreatedPayload,
  noteBodyEditedPayload,
  noteArchivedPayload,
} from './operations.js';

export {
  notesTable,
  noteCreatedApplier,
  noteBodyEditedApplier,
  noteArchivedApplier,
  type NoteCreatedV1Payload,
  type NoteCreatedV2Payload,
  type NoteBodyEditedPayload,
} from './applier.js';

export {
  createNoteInput,
  editNoteBodyInput,
  archiveNoteInput,
  createNoteHandler,
  editNoteBodyHandler,
  archiveNoteHandler,
  type CreateNoteInput,
  type EditNoteBodyInput,
  type ArchiveNoteInput,
} from './commands.js';

export {
  listNotesQuery,
  getNoteQuery,
  listNotesInput,
  getNoteInput,
  listNotesHandler,
  getNoteHandler,
  type ListNotesInput,
  type GetNoteInput,
  type NoteRow,
  type NoteSort,
} from './queries.js';

export {
  notesEditAfterArchive,
  editAfterArchiveConflict,
  EDIT_AFTER_ARCHIVE_KEY,
  type EditAfterArchiveDeclaration,
  type EditAfterArchiveHit,
} from './conflict-checks.js';
