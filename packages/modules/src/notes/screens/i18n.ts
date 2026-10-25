// Module-owned translations share the app's i18n instance and fallback behavior.
import { getI18nInstance, t } from '@bolusi/i18n';
import type { TranslationKey, TranslationValues } from '@bolusi/i18n';

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
] as const;

export type NotesKey = (typeof NOTES_KEYS)[number];

/** A shipped catalog locale tree, as the module JSON carries it (nested, prefix added at merge). */
export type NotesCatalogTree = Readonly<Record<string, unknown>>;

/**
 * Translate a `notes.*` key.
 *
 * Wraps the reserved-namespace `t()` so screens inherit its fallback logging (§6) and the identical
 * resolution path the core screens use. The single cast is the module-catalog escape hatch:
 * `t()`'s parameter is the generated reserved union, which by design excludes module namespaces
 * (§3.3); `NotesKey` is the module's typing and `registerNotesCatalog` is what makes the key resolve
 * at runtime.
 */
export function tn(key: NotesKey, values?: TranslationValues): string {
  const reserved = key as unknown as TranslationKey;
  return values === undefined ? t(reserved) : t(reserved, values);
}

/**
 * Merge the notes catalog into the shared i18n instance under the `notes` namespace (07-i18n §3.3).
 *
 * The catalog TREES are passed in, not imported here: the JSON lives OUTSIDE this package's compiled
 * `rootDir` (`packages/modules/notes/i18n`), so the composition root (apps/mobile) and the test
 * harness own the import and hand the parsed trees over. `deep`+`overwrite` make it idempotent, so
 * booting twice or re-registering in a test is safe.
 */
export function registerNotesCatalog(catalogs: {
  readonly id: NotesCatalogTree;
  readonly en: NotesCatalogTree;
}): void {
  const i18n = getI18nInstance();
  i18n.addResourceBundle('id', 'translation', { notes: catalogs.id }, true, true);
  i18n.addResourceBundle('en', 'translation', { notes: catalogs.en }, true, true);
}
