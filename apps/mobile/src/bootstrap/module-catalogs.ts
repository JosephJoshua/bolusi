/**
 * Register every module's SCREEN i18n catalog into the running i18n instance (07-i18n §3.3).
 *
 * ── WHY THIS LIVES IN THE COMPOSITION ROOT, NOT IN @bolusi/modules ───────────────────────────────
 * The reserved namespaces (`core`, `auth`, …) are statically bundled into `@bolusi/i18n` and loaded
 * by `initI18n`. Module namespaces (`notes.*`) are NOT: their catalogs live at
 * `packages/modules/<id>/i18n/{id,en}.json`, OUTSIDE both `@bolusi/i18n` (which has no RN imports)
 * and `@bolusi/modules`' compiled `rootDir`, and the registrar (`registerNotesCatalog`) lives in the
 * RN-only `@bolusi/modules/notes/screens` surface — importable ONLY from apps/mobile (08 §3.2,
 * boundary rule 3). So the platform-free `ALL_MODULES` list cannot carry this: the composition root
 * owns the JSON import and hands the parsed trees to each module's registrar. This function is that
 * one place — the SAME wiring `apps/mobile/test/notes-support.tsx` supplies for the screen tests,
 * which is why those ~600 tests stayed green while the shipping app rendered English (task 122).
 *
 * ── CONTRACT ─────────────────────────────────────────────────────────────────────────────────────
 * Call this AFTER `initI18n` (it targets the current instance via `getI18nInstance`, and each
 * `initI18n` replaces the instance) and BEFORE any screen resolves a label. Both real entries do:
 * `bootstrapI18n` (native, src/i18n.ts) and `index.web.tsx` (the web visual harness). It is
 * idempotent (`registerNotesCatalog` uses `deep`+`overwrite`), so calling it twice is safe.
 *
 * ── ADDING A MODULE ──────────────────────────────────────────────────────────────────────────────
 * A new module with screens adds ONE line here — import its catalogs + call its registrar — rather
 * than repeating the per-entry wiring. The fuller generalization (driving this off the module list so
 * a new module cannot forget) is a cross-package refactor tracked as task 123.
 */
import idNotesCatalog from '@bolusi/modules/notes/i18n/id.json';
import enNotesCatalog from '@bolusi/modules/notes/i18n/en.json';
import { registerNotesCatalog } from '@bolusi/modules/notes/screens';

/** Merge every module's screen catalog into the running i18n instance (07-i18n §3.3). */
export function registerModuleCatalogs(): void {
  registerNotesCatalog({ id: idNotesCatalog, en: enNotesCatalog });
}
