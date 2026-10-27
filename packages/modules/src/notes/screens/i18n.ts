// Module-owned translations share the app's i18n instance and fallback behavior.
import {
  moduleTranslator,
  registerModuleCatalog,
  type ModuleCatalogs,
  type ModuleCatalogTree,
} from '../../screen-kit/index.js';

// Keep the key vocabulary in one place; catalog parity is checked against both locales.
export const NOTES_KEYS = [
  'notes.list.title',
  'notes.detail.title',
  'notes.detail.meta',
  'notes.list.empty',
  'notes.list.emptyArchived',
  'notes.action.new',
  'notes.action.archive',
  'notes.action.attachPhoto',
  'notes.editor.titleField',
  'notes.editor.bodyField',
  'notes.editor.titleRequired',
  'notes.confirm.archive',
  'notes.badge.archived',
  'notes.filter.showArchived',
  'notes.filter.hideArchived',
  'notes.opType.noteCreated',
  'notes.opType.noteBodyEdited',
  'notes.opType.noteArchived',
  'notes.refusal.alreadyRecorded',
  'notes.refusal.noteNotFound',
] as const;

export type NotesKey = (typeof NOTES_KEYS)[number];

/** A shipped catalog locale tree, as the module JSON carries it. */
export type NotesCatalogTree = ModuleCatalogTree;

/** Translate a `notes.*` key (see `moduleTranslator`). */
export const tn = moduleTranslator<NotesKey>();

/** Merge the notes catalog into the shared i18n instance under the `notes` namespace. */
export function registerNotesCatalog(catalogs: ModuleCatalogs): void {
  registerModuleCatalog('notes', catalogs);
}
