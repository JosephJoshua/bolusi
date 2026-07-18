// The `notes` module manifest (04 §1; 01 §9) — the v0 exit-criterion reference module.
//
// This is the module `SERVER_MODULES` (apps/server/src/deps.ts) AND `CLIENT_MODULES`
// (apps/mobile/src/bootstrap/modules.ts) must carry. Registering it lights up, from ONE list, the
// op-payload validators, the projection appliers, the permission vocabulary and the operation
// registry (task 49's seam) — so a runtime can never validate a type it cannot fold, fold one it
// never validated, or gate a command on a permission the registry does not know (§2.8). Until it is
// appended to those lists, `notes.*` ops are `UNKNOWN_TYPE` and the `notes` projection stays empty
// in production, silently (the exact trap task 49 found; falsified in notes-registration.test.ts).
//
// It declares NO `migrations`: the `notes` DDL is owned by 10-db and already shipped on both engines
// (tasks 04/05). 04 §4.4's migration block is for a module bringing its OWN tables; re-declaring the
// DDL here would be a second source of truth about a schema that exists (§2.8). The applier
// conformance runner creates the table it needs from 10-db's DDL instead.
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import { notesTable } from './applier.js';
import {
  archiveNoteHandler,
  archiveNoteInput,
  createNoteHandler,
  createNoteInput,
  editNoteBodyHandler,
  editNoteBodyInput,
} from './commands.js';
import { NOTES_MODULE_ID, NOTES_PERMISSION, NOTES_TABLE } from './constants.js';
import { notesOperations } from './operations.js';
import { getNoteQuery, listNotesQuery } from './queries.js';
import type { NotesDatabase } from './schema.js';

/** The manifest as authored (04 §1). */
export const notesModuleManifest = {
  id: NOTES_MODULE_ID,

  operations: notesOperations,

  projections: {
    tables: {
      [NOTES_TABLE]: notesTable,
    },
    // No `migrations` — see the file header.
  },

  /**
   * The notes permission registry (02 §11.2, verbatim: ids, scopes, `isDangerous`, canonical EN
   * descriptions). All four are `scope: 'store'` (02 §12): the check evaluates in the device's store
   * (02 §5.2), which is the store every note op is stamped in — a note belongs to one store (01 §9).
   * None is `isDangerous`: a note is not a security surface.
   */
  permissions: {
    [NOTES_PERMISSION.create]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can create a note in the store.',
    },
    [NOTES_PERMISSION.edit]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can edit the body of an existing note.',
    },
    [NOTES_PERMISSION.archive]: {
      scope: 'store',
      isDangerous: false,
      description: "Can archive a note, removing it from the store's active list.",
    },
    [NOTES_PERMISSION.read]: {
      scope: 'store',
      isDangerous: false,
      description: "Can read the store's notes.",
    },
  },

  commands: {
    createNote: {
      permission: NOTES_PERMISSION.create,
      input: createNoteInput,
      handler: createNoteHandler,
    },
    editNoteBody: {
      permission: NOTES_PERMISSION.edit,
      input: editNoteBodyInput,
      handler: editNoteBodyHandler,
    },
    archiveNote: {
      permission: NOTES_PERMISSION.archive,
      input: archiveNoteInput,
      handler: archiveNoteHandler,
    },
  },

  queries: {
    listNotes: listNotesQuery,
    getNote: getNoteQuery,
  },
} as const satisfies ModuleManifest<NotesDatabase>;

/**
 * The defined `notes` module — validated at IMPORT time (04 §3/§4.4). A malformed manifest (a
 * present-tense op type, a non-strict payload, a missing reversal, an undeclared entityIdColumn) is
 * a STARTUP FAILURE for every consumer, not a per-consumer obligation — the same reason the platform
 * module calls `defineModule` inside its own package rather than exporting a raw manifest.
 */
export const notesModule: ModuleDefinition<NotesDatabase, typeof notesModuleManifest> =
  defineModule<NotesDatabase, typeof notesModuleManifest>(notesModuleManifest);
