// The `notes` reference module's identifiers (04-module-contract §1; 01-domain-model §9).
//
// One place for the module id, its op types, its entity type, its projection table name, and its
// permission ids — so the manifest, the appliers, the commands, the queries and the tests all name
// the same strings and cannot drift (CLAUDE.md §2.8). Op types are PAST tense (05 §2.1); permission
// ids are PRESENT tense (02 §2) — the two registries are far apart, and the grammar is what keeps a
// permission from wearing an op's clothes.

/** Lowercase module id (04 §1) — prefixes every op type and permission this module declares. */
export const NOTES_MODULE_ID = 'notes' as const;

/** The one entity this module projects (01 §9). The `(entityType, entityId)` §4.2 re-fold key. */
export const NOTE_ENTITY = 'note' as const;

/** The projection table (10-db `notes`, both engines). */
export const NOTES_TABLE = 'notes' as const;

/** The op types the `notes` manifest declares (01 §9; grammar 04 §3 / op-type.ts). */
export const NOTES_OP = {
  noteCreated: 'notes.note_created',
  noteBodyEdited: 'notes.note_body_edited',
  noteArchived: 'notes.note_archived',
} as const;

/** The permission ids (02 §11.2, matrix §12). All `scope: 'store'`. */
export const NOTES_PERMISSION = {
  create: 'notes.create',
  edit: 'notes.edit',
  archive: 'notes.archive',
  read: 'notes.read',
} as const;

/**
 * The current payload version of `notes.note_created` (01 §9): v2 added `mediaId`, v3 replaced it
 * with the whole signed `mediaRef` so a PULLED note can download-verify its photo against a hash the
 * op's signature covers (06 §6 / 05 §2 — see operations.ts for the full argument). The applier folds
 * ALL THREE forever (05 §7 — old ops never disappear); the registry's payload schema and every
 * freshly-emitted op are v3. `note_body_edited` and `note_archived` are v1 only.
 */
export const NOTE_CREATED_SCHEMA_VERSION = 3 as const;

/** The conflict key `note_body_edited` declares (01 §8.1) — Rule-1 detection keys off it. */
export const NOTE_BODY_CONFLICT_KEY = 'note.body' as const;
