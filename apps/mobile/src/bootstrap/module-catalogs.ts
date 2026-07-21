/**
 * The client-screens catalog registry — every module that ships screens registers its i18n catalog
 * from ONE list here, folded into the running i18n instance at boot (07-i18n §3.3).
 *
 * ── WHY THIS LIVES IN THE COMPOSITION ROOT, NOT IN @bolusi/modules ───────────────────────────────
 * The reserved namespaces (`core`, `auth`, …) are statically bundled into `@bolusi/i18n` and loaded
 * by `initI18n`. Module namespaces (`notes.*`) are NOT: their catalogs live at
 * `packages/modules/<id>/i18n/{id,en}.json`, OUTSIDE both `@bolusi/i18n` (which has no RN imports)
 * and `@bolusi/modules`' compiled `rootDir`, and the registrar (`registerNotesCatalog`) lives in the
 * RN-only `@bolusi/modules/notes/screens` surface — importable ONLY from apps/mobile (08 §3.2,
 * boundary rule 3). So the platform-free `ALL_MODULES` list cannot carry this: the composition root
 * owns the JSON import and hands the parsed trees to each module's registrar. This file is that one
 * place — the SAME wiring `apps/mobile/test/notes-support.tsx` supplies for the screen tests, which
 * is why those ~600 tests stayed green while the shipping app rendered English (task 122).
 *
 * ── ONE LIST, GUARDED BY COVERAGE (task 123; the class task 122 could not close) ──────────────────
 * `CLIENT_SCREEN_MODULES` is the single source `registerModuleCatalogs` folds over. It is not enough
 * on its own — a hand-maintained list can still forget the NEXT module (nothing crashes; its `*.`
 * chrome silently falls back to the humanized English key, invisible to every screen test whose
 * harness registers the catalog itself). So `apps/mobile/test/module-catalog-coverage.test.ts`
 * asserts this list's moduleId SET EQUALS the screen-bearing subset of `ALL_MODULES` — the modules
 * in the one registration list (task 90) that also declare a `./<id>/screens` export. A module that
 * ships screens (its `./<id>/screens` export is what makes apps/mobile able to render them at all —
 * boundary rule 3) without a row here turns that test RED, naming the module. That is the T-14
 * denominator move: assert the SET, not "no throw" — so the omission cannot be silent.
 *
 * ── CONTRACT ─────────────────────────────────────────────────────────────────────────────────────
 * Call `registerModuleCatalogs` AFTER `initI18n` (it targets the current instance via
 * `getI18nInstance`, and each `initI18n` replaces the instance) and BEFORE any screen resolves a
 * label. Both real entries do: `bootstrapI18n` (native, src/i18n.ts) and `index.web.tsx` (the web
 * visual harness). It is idempotent (`registerNotesCatalog` uses `deep`+`overwrite`), so calling it
 * twice is safe.
 *
 * ── ADDING A MODULE ──────────────────────────────────────────────────────────────────────────────
 * A new module with screens adds ONE row to `CLIENT_SCREEN_MODULES` — import its catalogs + name its
 * registrar. Skip it and the coverage guard reds; there is no per-entry wiring to repeat.
 */
import idNotesCatalog from '@bolusi/modules/notes/i18n/id.json';
import enNotesCatalog from '@bolusi/modules/notes/i18n/en.json';
import { registerNotesCatalog } from '@bolusi/modules/notes/screens';

/** A shipped catalog locale tree (nested JSON; the `<id>` namespace prefix is added at merge, §3.3). */
type ModuleCatalogTree = Readonly<Record<string, unknown>>;

/** One module's client-screen catalog wiring: which module, how to register it, and its trees. */
interface ClientScreenModule {
  /**
   * The manifest id (04 §1). MUST equal the module's id in `ALL_MODULES`; the coverage guard asserts
   * this set against the screen-bearing subset of `ALL_MODULES`, so a typo here reds that test.
   */
  readonly moduleId: string;
  /** The module's RN-only registrar — merges the trees into the running i18n instance under `<id>`. */
  readonly register: (catalogs: {
    readonly id: ModuleCatalogTree;
    readonly en: ModuleCatalogTree;
  }) => void;
  /** The shipped catalog trees, imported HERE (outside `@bolusi/modules`' rootDir) by this root. */
  readonly catalogs: { readonly id: ModuleCatalogTree; readonly en: ModuleCatalogTree };
}

/**
 * THE client-screens registry — one row per module that ships screens. `registerModuleCatalogs`
 * folds over it, and `module-catalog-coverage.test.ts` pins its moduleId set to the screen-bearing
 * subset of `ALL_MODULES`, so a new screen-bearing module that omits its row reds a committed test.
 */
export const CLIENT_SCREEN_MODULES: readonly ClientScreenModule[] = [
  {
    moduleId: 'notes',
    register: registerNotesCatalog,
    catalogs: { id: idNotesCatalog, en: enNotesCatalog },
  },
];

/** Merge every client-screen module's catalog into the running i18n instance (07-i18n §3.3). */
export function registerModuleCatalogs(): void {
  for (const mod of CLIENT_SCREEN_MODULES) {
    mod.register(mod.catalogs);
  }
}
