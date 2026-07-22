/**
 * LOAD-BEARING coverage guard for task 123 — the client-screens catalog registry
 * (`apps/mobile/src/bootstrap/module-catalogs.ts`) must cover EXACTLY the screen-bearing modules of
 * `ALL_MODULES`, so the NEXT module that ships screens cannot silently omit its i18n catalog and
 * render English chrome (the task-122 defect, generalized).
 *
 * ── WHAT "SCREEN-BEARING SUBSET OF ALL_MODULES" MEANS, AND WHY IT IS COMPUTED PLATFORM-FREE ───────
 * `ALL_MODULES` (task 90) is the ONE registration list and is platform-free by design (08 §3.2): it
 * carries only manifests and must never import `./screens`. So the denominator is derived WITHOUT
 * importing any screen surface: a module ships screens iff `@bolusi/modules` declares a
 * `./<id>/screens` export — that subpath is the ONLY way apps/mobile can import its screens at all
 * (boundary rule 3), so the export existing IS "has screens", and it cannot be forgotten while the
 * module still renders. The denominator is thus `ALL_MODULES`' ids intersected with the module ids
 * that declare a `./<id>/screens` export in `@bolusi/modules`' package.json — read as plain JSON
 * here (a Node test reading a file, not an RN import), keeping the RN registrar out of every
 * platform-free graph.
 *
 * ── WHY THE EQUALITY, NOT "NO THROW" (T-14 denominator move; §2.11) ──────────────────────────────
 * A registration list's failure mode is a SILENT omission. A "does registration throw?" test stays
 * green when a module is missing entirely. Asserting the SET both directions is what turns "screens
 * added, catalog forgotten" RED — and the `detects a screen-bearing module with no catalog row` test
 * below proves the detector is not vacuous (it NAMES the missing module), so the equality above
 * cannot pass by checking nothing.
 *
 * ── TASK 132: MEMBERSHIP IS NOT CONTENT, AND THE DENOMINATOR HAD A HOLE ──────────────────────────
 * The set-equality above is necessary and was never sufficient, in two independent ways that task
 * 132's coverage sweep found:
 *
 *  1. **A row can be present and still ship nothing.** `catalogs: { id: {}, en: {} }` satisfies every
 *     assertion above, and so does a `register` that returns without calling `addResourceBundle` —
 *     both produce exactly the task-122 symptom (module chrome falling back to the humanized English
 *     key) while the membership guard stays green. The content proof that DID exist
 *     (`notes-catalog-boot.test.tsx`) is hard-coded to `notes`: it cannot grow with the registry, so
 *     module #2 would ship with membership checked and content unchecked. The `SHIPPED CONTENT`
 *     block below closes that by folding over `CLIENT_SCREEN_MODULES` itself — no module id appears
 *     as a literal anywhere in it.
 *  2. **The id grammar silently dropped whole modules from the denominator.** The export-key regex
 *     was `^\./([a-z][a-z0-9]*)/screens$`, which matches neither `-` nor `_`. A module id containing
 *     either fell out of `moduleIdsWithScreensExport()`, therefore out of `screenBearing`, therefore
 *     out of BOTH sides of the equality — and two sets that are both missing the same element are
 *     still equal, so the guard reported green about a module it had never looked at. That is the
 *     T-14 failure mode exactly ("verified a fraction, reported green"). Two fixes, because widening
 *     the grammar alone would only move the boundary rather than close the class: the grammar now
 *     admits `-`/`_` separators, AND `unparsedScreensExportKeys` asserts the guard's own coverage —
 *     any export key SHAPED like `./…/screens` that the grammar cannot parse is now RED rather than
 *     invisible. A future grammar change therefore fails loudly instead of shrinking the denominator.
 *
 * ── HONEST SCOPE OF FIX 2 (T-16: trace it, do not just assert it) ─────────────────────────────────
 * Today a hyphenated id cannot actually reach `ALL_MODULES`: `defineModule` validates ids against
 * `/^[a-z][a-z0-9]*$/` (`packages/core/src/module/define-module.ts`) and throws at import time. So
 * the hole was in THIS guard's denominator rather than in shipping behaviour, and the widened
 * grammar is defence-in-depth for a manifest that does not route through `defineModule` or for a
 * later relaxation of 04 §1. The part that is load-bearing NOW is `unparsedScreensExportKeys`: it
 * makes the guard state what it covered instead of quietly covering less.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasKey, type Locale } from '@bolusi/i18n';
import { ALL_MODULES } from '@bolusi/modules';
import { beforeAll, describe, expect, test } from 'vitest';

import { CLIENT_SCREEN_MODULES } from '../src/bootstrap/module-catalogs.js';
import { bootstrapI18n } from '../src/i18n.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The module-id grammar for a `./<id>/screens` export key.
 *
 * Deliberately WIDER than `defineModule`'s current `^[a-z][a-z0-9]*$`: a guard's denominator must
 * never be narrower than the thing it counts, because anything it cannot parse disappears from both
 * sides of an equality instead of failing it (task 132). `-`/`_` are admitted as separators between
 * alphanumeric segments — never leading, trailing, or doubled, so this stays a grammar and not a
 * wildcard that would launder a malformed key into a plausible id.
 */
const SCREENS_EXPORT_KEY = /^\.\/([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\/screens$/;

/**
 * Anything SHAPED like a screens subpath, whatever the id looks like — the coverage denominator for
 * the grammar above. Any key this matches and `SCREENS_EXPORT_KEY` does not is a module the guard
 * would have skipped in silence.
 */
const SCREENS_EXPORT_SHAPE = /^\.\/[^/]+\/screens$/;

/** The locales every module catalog ships (07-i18n §1); tied to the real union, not a copy. */
const CATALOG_LOCALES = ['id', 'en'] as const satisfies readonly Locale[];

/** A shipped catalog locale tree, as `module-catalogs.ts` hands it to the module's registrar. */
type CatalogTree = Readonly<Record<string, unknown>>;

/** The slice of a `CLIENT_SCREEN_MODULES` row the content assertions read. */
interface CatalogRow {
  readonly moduleId: string;
  readonly catalogs: { readonly id: CatalogTree; readonly en: CatalogTree };
}

/** `@bolusi/modules`' export keys, read as plain JSON (no RN import — see the header). */
function moduleExportKeys(): string[] {
  const pkgPath = resolve(HERE, '../../../packages/modules/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, unknown> };
  return Object.keys(pkg.exports ?? {});
}

/** Module ids parsed out of `./<id>/screens` export keys. Pure, so the grammar is testable. */
function parseScreensExportKeys(exportKeys: readonly string[]): string[] {
  const ids: string[] = [];
  for (const key of exportKeys) {
    const id = SCREENS_EXPORT_KEY.exec(key)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Export keys that LOOK like a screens subpath but that the id grammar cannot parse — the guard
 * asserting its own coverage (T-14). Non-empty means the denominator below is short by that many
 * modules, which is precisely the state that used to read as green.
 */
function unparsedScreensExportKeys(exportKeys: readonly string[]): string[] {
  const parsed = new Set(parseScreensExportKeys(exportKeys).map((id) => `./${id}/screens`));
  return exportKeys.filter((key) => SCREENS_EXPORT_SHAPE.test(key) && !parsed.has(key)).sort();
}

/** The screen-bearing subset of a module-id list. Pure over both inputs so the drop-out is testable. */
function screenBearingOf(allModuleIds: readonly string[], exportKeys: readonly string[]): string[] {
  const withScreens = new Set(parseScreensExportKeys(exportKeys));
  return allModuleIds.filter((id) => withScreens.has(id));
}

/** The screen-bearing subset of `ALL_MODULES`: registered modules that also ship a screens surface. */
function screenBearingModuleIds(): string[] {
  return screenBearingOf(
    ALL_MODULES.map((module) => module.id),
    moduleExportKeys(),
  );
}

/**
 * Screen-bearing module ids with NO client-screens registry row — the guard's whole point. Pure over
 * its inputs so the vacuity test can prove it NAMES the omission rather than silently returning `[]`.
 */
function modulesMissingCatalogRow(
  screenBearing: readonly string[],
  registered: readonly string[],
): string[] {
  const have = new Set(registered);
  return screenBearing.filter((id) => !have.has(id)).sort();
}

/** Registry rows for a module that is not a screen-bearing module of `ALL_MODULES` (stale/typo). */
function catalogRowsWithoutScreens(
  screenBearing: readonly string[],
  registered: readonly string[],
): string[] {
  const bearing = new Set(screenBearing);
  return registered.filter((id) => !bearing.has(id)).sort();
}

/** Dotted leaf paths of a catalog tree (`{ list: { title: 'Catatan' } }` → `['list.title']`). */
function leafPaths(tree: CatalogTree, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'object' && value !== null) {
      out.push(...leafPaths(value as CatalogTree, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/**
 * `<moduleId>:<locale>` for every registered module shipping an EMPTY tree in some locale — the
 * `catalogs: { id: {}, en: {} }` row that satisfies membership and localizes nothing.
 */
function modulesWithEmptyCatalog(rows: readonly CatalogRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const locale of CATALOG_LOCALES) {
      if (leafPaths(row.catalogs[locale]).length === 0) out.push(`${row.moduleId}:${locale}`);
    }
  }
  return out.sort();
}

/**
 * `<locale>:<moduleId>.<leaf>` for every shipped catalog leaf that does NOT resolve after boot — the
 * no-op (or wrong-namespace) `register`. `resolves` is injected so the vacuity test can drive the
 * detector with a known-false oracle and watch it NAME the module (T-13: interrogate the oracle).
 */
function unresolvedCatalogKeys(
  rows: readonly CatalogRow[],
  resolves: (key: string, locale: Locale) => boolean,
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const locale of CATALOG_LOCALES) {
      for (const leaf of leafPaths(row.catalogs[locale])) {
        const key = `${row.moduleId}.${leaf}`;
        if (!resolves(key, locale)) out.push(`${locale}:${key}`);
      }
    }
  }
  return out.sort();
}

/** Every `(module, locale, leaf)` triple the resolution assertion covers — its own denominator. */
function shippedLeafCount(rows: readonly CatalogRow[]): number {
  return rows.reduce(
    (total, row) =>
      total +
      CATALOG_LOCALES.reduce((sub, locale) => sub + leafPaths(row.catalogs[locale]).length, 0),
    0,
  );
}

describe('module i18n catalog coverage (task 123)', () => {
  const registered = CLIENT_SCREEN_MODULES.map((module) => module.moduleId);
  const screenBearing = screenBearingModuleIds();

  test('the screen-bearing subset of ALL_MODULES is non-empty (contains notes)', () => {
    // Non-vacuity (T-15): if the package.json parse silently found no screens export, the equality
    // tests below could pass with both sides empty. Pinning the denominator to reality reds instead.
    expect(screenBearing).toContain('notes');
  });

  test('every screen-bearing module of ALL_MODULES has a client-screens catalog row', () => {
    expect(modulesMissingCatalogRow(screenBearing, registered)).toEqual([]);
  });

  test('every client-screens catalog row maps to a screen-bearing module of ALL_MODULES', () => {
    expect(catalogRowsWithoutScreens(screenBearing, registered)).toEqual([]);
  });

  test('the detector NAMES a screen-bearing module that has no catalog row (guard is not vacuous)', () => {
    // The exact scenario the guard exists to catch: a screen-bearing module absent from the registry.
    expect(modulesMissingCatalogRow(['notes', 'ghost'], ['notes'])).toEqual(['ghost']);
    // And it stays silent only when coverage is genuinely complete.
    expect(modulesMissingCatalogRow(['notes'], ['notes'])).toEqual([]);
  });
});

// ── THE DENOMINATOR ITSELF (task 132 fix 2) ──────────────────────────────────────────────────────
describe('the screens-export denominator covers every module it should (task 132)', () => {
  test('no `./…/screens` export key is dropped by the id grammar', () => {
    // The guard asserting its own coverage. A key this reports is a module that would vanish from
    // BOTH sides of the equalities above — where absence is indistinguishable from compliance.
    expect(unparsedScreensExportKeys(moduleExportKeys())).toEqual([]);
    // And the shipped denominator is not empty, which is the other way this could read green.
    expect(parseScreensExportKeys(moduleExportKeys()).length).toBeGreaterThan(0);
  });

  test('the coverage detector NAMES an export key its grammar cannot parse (not vacuous)', () => {
    // `./Notes/screens` is screens-SHAPED but ungrammatical (uppercase), so it must be reported —
    // whereas the two separator forms below must parse, or fix 2 did not happen.
    expect(
      unparsedScreensExportKeys([
        './notes/screens',
        './point-of-sale/screens',
        './stock_take/screens',
        './Notes/screens',
      ]),
    ).toEqual(['./Notes/screens']);
    // A non-screens export key is out of scope and must NOT be reported as a gap.
    expect(unparsedScreensExportKeys(['.', './notes', './notes/i18n/id.json'])).toEqual([]);
  });

  test('a module id containing `-` or `_` is counted on BOTH sides, not silently dropped', () => {
    // The task-132 defect, as a committed regression test. Under the old grammar
    // (`^\./([a-z][a-z0-9]*)/screens$`) `screenBearingOf` returned ONLY `['notes']` here, so
    // `modulesMissingCatalogRow` compared two sets that were both missing the same two modules and
    // reported `[]` — green, while two screen-bearing modules had no catalog at all.
    const allIds = ['platform', 'notes', 'point-of-sale', 'stock_take', 'auth'];
    const exportKeys = ['./notes/screens', './point-of-sale/screens', './stock_take/screens'];

    expect(screenBearingOf(allIds, exportKeys)).toEqual(['notes', 'point-of-sale', 'stock_take']);
    expect(modulesMissingCatalogRow(screenBearingOf(allIds, exportKeys), ['notes'])).toEqual([
      'point-of-sale',
      'stock_take',
    ]);
  });

  test('the grammar stays a grammar — malformed separators are reported, not laundered into ids', () => {
    expect(
      parseScreensExportKeys(['./-notes/screens', './notes-/screens', './no--tes/screens']),
    ).toEqual([]);
    expect(unparsedScreensExportKeys(['./-notes/screens'])).toEqual(['./-notes/screens']);
  });
});

// ── SHIPPED CONTENT, NOT JUST MEMBERSHIP (task 132 fix 1) ────────────────────────────────────────
// Everything below folds over `CLIENT_SCREEN_MODULES`; no module id is written as a literal, so the
// proof grows with the registry instead of staying pinned to `notes` the way
// `notes-catalog-boot.test.tsx` is.
describe('every registered module ships resolvable catalog CONTENT (task 132)', () => {
  beforeAll(async () => {
    // The REAL production boot — the function `Root`/`index.ts` run on native — not a hand-rolled
    // `registerModuleCatalogs()` call. So this also reds if `bootstrapI18n` ever stops registering
    // module catalogs, and it reds for EVERY module rather than only for `notes`.
    await bootstrapI18n({ read: () => Promise.resolve(null), write: () => Promise.resolve() });
  });

  test('no registered module ships an empty catalog tree in any locale', () => {
    expect(modulesWithEmptyCatalog(CLIENT_SCREEN_MODULES)).toEqual([]);
  });

  test('the production boot RESOLVES every shipped leaf under its own module namespace', () => {
    // `hasKey` is the real per-locale existence probe with `fallbackLng: false`, so an `en` gap
    // cannot be masked by the `id` catalog answering for it.
    expect(unresolvedCatalogKeys(CLIENT_SCREEN_MODULES, hasKey)).toEqual([]);

    // This assertion's own denominator (T-14): an empty registry, an empty tree, or a `leafPaths`
    // that stopped descending would all make the line above pass by checking nothing. Today the
    // real count is 22 (1 module x 2 locales x 11 keys); the floor sits well under it so adding or
    // renaming catalog keys never trips it, while a starved parse fails loudly.
    expect(shippedLeafCount(CLIENT_SCREEN_MODULES)).toBeGreaterThanOrEqual(10);
  });

  test('the content detectors NAME the offending module (neither guard is vacuous)', () => {
    // An empty-tree row — membership-legal, localizes nothing.
    expect(modulesWithEmptyCatalog([{ moduleId: 'ghost', catalogs: { id: {}, en: {} } }])).toEqual([
      'ghost:en',
      'ghost:id',
    ]);
    // Half-empty is still a gap, and the locale is named.
    expect(
      modulesWithEmptyCatalog([{ moduleId: 'ghost', catalogs: { id: { a: 'x' }, en: {} } }]),
    ).toEqual(['ghost:en']);
    // A populated row is silent — the detector is not just returning everything it is given.
    expect(
      modulesWithEmptyCatalog([
        { moduleId: 'ghost', catalogs: { id: { a: 'x' }, en: { a: 'y' } } },
      ]),
    ).toEqual([]);

    // A no-op `register` looks exactly like this: leaves are shipped and resolve nowhere.
    const ghost = [{ moduleId: 'ghost', catalogs: { id: { a: 'x' }, en: { a: 'y' } } }];
    expect(unresolvedCatalogKeys(ghost, () => false)).toEqual(['en:ghost.a', 'id:ghost.a']);
    // And a locale-specific miss is named per locale, not collapsed.
    expect(unresolvedCatalogKeys(ghost, (_key, locale) => locale === 'id')).toEqual(['en:ghost.a']);
    expect(unresolvedCatalogKeys(ghost, () => true)).toEqual([]);
  });

  test('leafPaths descends nested trees — the parse the content assertions depend on', () => {
    // T-13: the oracle above is only as good as this. A `leafPaths` that stopped at depth 1 would
    // make `unresolvedCatalogKeys` probe `notes.list` (which does not resolve) or nothing at all.
    expect(leafPaths({ list: { title: 'Catatan' }, badge: { archived: 'Diarsipkan' } })).toEqual([
      'list.title',
      'badge.archived',
    ]);
    expect(leafPaths({})).toEqual([]);
  });
});
