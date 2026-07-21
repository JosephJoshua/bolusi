// The notes module's i18n seam for its screens (07-i18n §3.1/§3.3).
//
// WHY A MODULE-LOCAL TRANSLATE AND REGISTRATION EXIST. The reserved-namespace `t()` from
// `@bolusi/i18n` types its key against a GENERATED union built from `packages/i18n/catalogs/*`
// (07-i18n §3.4) — which, by design, does NOT include module-owned namespaces: 07-i18n §3.3 puts
// each module's catalog under `packages/modules/<id>/i18n/` and says the runtime "merges every
// catalog" at load. The merge for module catalogs was never wired (task 25 shipped the `notes/i18n`
// JSON but nothing loaded it), so this file is the notes module's half of that contract:
//   - `registerNotesCatalog` merges the shipped catalog trees into the shared instance under the
//     `notes` namespace, exactly as §3.3 specifies (`resources[locale].translation.notes = tree`).
//   - `tn` is the typed entry point screens call; its `NotesKey` union is this module's own key
//     typing (the generated union cannot carry it), kept EQUAL to the shipped catalog by a
//     key-parity test (§2.11 gated mirror), so a screen typo is still a compile error.
import { getI18nInstance, t } from '@bolusi/i18n';
import type { TranslationKey, TranslationValues } from '@bolusi/i18n';

/**
 * Every `notes.*` label key (ui-labels.md §notes; 07-i18n §3.1 grammar). Hand-declared because the
 * reserved-namespace generated union (07-i18n §3.4) does not include module namespaces — this is the
 * module's own typing, pinned to the shipped catalog by `screens/i18n.test`'s parity assertion.
 */
export type NotesKey =
  | 'notes.list.title'
  | 'notes.list.empty'
  | 'notes.action.new'
  | 'notes.action.archive'
  | 'notes.action.attachPhoto'
  | 'notes.editor.titleField'
  | 'notes.editor.bodyField'
  | 'notes.editor.titleRequired'
  | 'notes.confirm.archive'
  | 'notes.badge.archived'
  | 'notes.filter.showArchived';

/** The runtime-checkable list — the single source `screens/i18n.test` reads as its denominator. */
export const NOTES_KEYS: readonly NotesKey[] = [
  'notes.list.title',
  'notes.list.empty',
  'notes.action.new',
  'notes.action.archive',
  'notes.action.attachPhoto',
  'notes.editor.titleField',
  'notes.editor.bodyField',
  'notes.editor.titleRequired',
  'notes.confirm.archive',
  'notes.badge.archived',
  'notes.filter.showArchived',
];

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
