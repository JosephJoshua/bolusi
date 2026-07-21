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
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_MODULES } from '@bolusi/modules';
import { describe, expect, test } from 'vitest';

import { CLIENT_SCREEN_MODULES } from '../src/bootstrap/module-catalogs.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Module ids that declare a `./<id>/screens` export in `@bolusi/modules`' package.json. */
function moduleIdsWithScreensExport(): string[] {
  const pkgPath = resolve(HERE, '../../../packages/modules/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, unknown> };
  const ids: string[] = [];
  for (const key of Object.keys(pkg.exports ?? {})) {
    const id = /^\.\/([a-z][a-z0-9]*)\/screens$/.exec(key)?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** The screen-bearing subset of `ALL_MODULES`: registered modules that also ship a screens surface. */
function screenBearingModuleIds(): string[] {
  const withScreens = new Set(moduleIdsWithScreensExport());
  return ALL_MODULES.map((module) => module.id).filter((id) => withScreens.has(id));
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
