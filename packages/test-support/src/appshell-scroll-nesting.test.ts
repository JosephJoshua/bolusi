/**
 * A screen may not put a `List` inside a scrolling `AppShell` content slot (task 206).
 *
 * WHY THIS IS A SOURCE-LEVEL GUARD AND NOT A RENDER TEST. `List` renders a `FlatList`, and RN
 * refuses to nest a same-orientation `VirtualizedList` inside a plain `ScrollView` — it logs
 * "VirtualizedLists should never be nested inside plain ScrollViews with the same orientation
 * because it can break windowing" and `onEndReached`/windowing stop working. None of that is
 * observable from a test: `packages/ui/test/doubles/react-native.tsx` replaces BOTH `ScrollView` and
 * `FlatList` with pass-through host nodes, so no test that mounts a screen can ever see it. That is
 * how the original task-206 fix shipped a ScrollView around every List-bearing screen with 1,362
 * tests green — found only by a reviewer reading RN's source.
 *
 * WHY IT FOLLOWS IMPORTS. A first version matched `<List` in the same file that set `scrollable`.
 * The PR-5 review broke that in two lines, by executing the regex rather than reasoning about it:
 *   • `import { List as Rows }` — the tag is `<Rows`, so the file-local match misses it;
 *   • `<StoreRowsList />` — a sibling component that renders the `List` in ITS own file.
 * Both are ordinary refactors this codebase already performs, so the guard resolves the local
 * binding name for `List` and walks relative imports to a fixpoint. A component that reaches a
 * `List` through any chain of repo-local modules counts as rendering one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const ROOTS = ['apps/mobile/src', 'packages/modules/src', 'packages/ui/src'];
const SKIP = new Set(['node_modules', 'dist', '.expo', 'android', 'ios', 'coverage']);

function collect(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path, out);
    // `.ts` as well as `.tsx`: a barrel like `packages/modules/src/notes/screens/index.ts` renders
    // nothing itself but is the EDGE that carries a screen to a `<List>` in a sibling file. Dropping
    // `.ts` broke the chain at exactly that hop — the cross-package case this guard was widened for.
    else if (
      (entry.endsWith('.tsx') || entry.endsWith('.ts')) &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.test.ts')
    )
      out.push(path);
  }
  return out;
}

const files = new Map<string, string>();
for (const root of ROOTS) {
  for (const path of collect(join(REPO_ROOT, root), []))
    files.set(path, readFileSync(path, 'utf8'));
}

/**
 * The local binding `List` was imported under, or null. Covers `List`, `List as Rows`, and the
 * `type`-prefixed forms, across multi-line import blocks.
 */
function listBinding(text: string): string | null {
  for (const block of text.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const spec of (block[1] ?? '').split(',')) {
      const matched = spec.trim().match(/^(?:type\s+)?List(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (matched) return matched[1] ?? 'List';
    }
  }
  return null;
}

/** Does this file itself render the `List` component (under whatever name it bound)? */
function rendersListDirectly(text: string): boolean {
  const binding = listBinding(text);
  if (binding === null) return false;
  return new RegExp(`<${binding}[\\s/>]`).test(text);
}

/**
 * Repo-local modules this file imports — relative paths AND workspace `@bolusi/*` specifiers.
 *
 * Following the workspace specifiers matters: `apps/mobile/src/screens/notes/NotesHome.tsx` reaches
 * the notes screens through `@bolusi/modules/notes/screens`, and its own docstring calls that "the
 * reference wiring every future module surface copies". A relative-only walk would miss a screen that
 * set `scrollable` and reached a `<List>` across a package boundary — the guard would pass silently,
 * which is the failure mode it exists to prevent. (Found by a QA sweep of the guard itself.)
 */
function localImports(path: string, text: string): string[] {
  const out: string[] = [];
  for (const spec of text.matchAll(/from\s*['"](@bolusi\/[^'"]+)['"]/g)) {
    const target = spec[1];
    if (target === undefined) continue;
    // `@bolusi/modules/notes/screens` → packages/modules/src/notes/screens; `@bolusi/ui` → packages/ui/src.
    const [, pkg, ...rest] = target.split('/');
    if (pkg === undefined) continue;
    const base = join(REPO_ROOT, 'packages', pkg, 'src', ...rest);
    for (const candidate of [
      `${base}.tsx`,
      `${base}.ts`,
      join(base, 'index.tsx'),
      join(base, 'index.ts'),
    ]) {
      if (files.has(candidate)) out.push(candidate);
    }
  }
  for (const spec of text.matchAll(/from\s*['"](\.[^'"]*)['"]/g)) {
    const target = spec[1];
    if (target === undefined) continue;
    const base = resolve(dirname(path), target.replace(/\.js$/, ''));
    for (const candidate of [
      `${base}.tsx`,
      `${base}.ts`,
      join(base, 'index.tsx'),
      join(base, 'index.ts'),
    ]) {
      if (files.has(candidate)) out.push(candidate);
    }
  }
  return out;
}

/** Files that reach a `List` directly or through any chain of repo-local imports. */
function reachesList(): Set<string> {
  const reaches = new Set<string>();
  for (const [path, text] of files) if (rendersListDirectly(text)) reaches.add(path);
  for (let changed = true; changed;) {
    changed = false;
    for (const [path, text] of files) {
      if (reaches.has(path)) continue;
      if (localImports(path, text).some((dep) => reaches.has(dep))) {
        reaches.add(path);
        changed = true;
      }
    }
  }
  return reaches;
}

const screens = [...files].filter(([, text]) => text.includes('<AppShell'));

test('the AppShell screen scan finds screens at all', () => {
  // T-14 denominator. If the walk breaks, every assertion below passes over an empty set and this
  // file becomes a green that checks nothing — the failure mode the guard exists to prevent.
  expect(screens.length).toBeGreaterThanOrEqual(10);
});

test('the List detector actually finds the known List-bearing screens', () => {
  // Second denominator, and the one that matters: if `listBinding`/`reachesList` silently stopped
  // matching, the guard below would report no offenders for the wrong reason. These five render a
  // `<List>` today; the count is deliberately a floor, so adding a screen does not break it.
  const withList = [...reachesList()].filter((path) => files.get(path)?.includes('<AppShell'));
  expect(withList.length).toBeGreaterThanOrEqual(5);
});

test('no screen opts into AppShell scrolling while reaching a List', () => {
  const reaches = reachesList();
  const offenders = screens
    .filter(([path, text]) => /\bscrollable\b/.test(text) && reaches.has(path))
    .map(([path]) => relative(REPO_ROOT, path));

  expect(
    offenders,
    `These screens pass \`scrollable\` to AppShell AND reach a <List> (directly, under an import ` +
      `alias, or through a component they compose). A List is a FlatList, and RN breaks windowing ` +
      `when one is nested in a same-orientation ScrollView. Such a screen already scrolls through ` +
      `its list — drop \`scrollable\`.`,
  ).toEqual([]);
});

test('no ConfirmSheet renders inside a scrollable AppShell content slot', () => {
  // ConfirmSheet's root is `position:'absolute'` with all four edges at 0, so its box resolves
  // against its containing block. Passed as an AppShell CHILD on a `scrollable` screen, that block is
  // the ScrollView's content — the full scrollable height, not the viewport — so on a long screen the
  // sheet's bottom-docked Cancel/Confirm render below the visible window. A confirmation whose
  // buttons are off-screen is worse than no confirmation. AppShell's `overlay` slot renders outside
  // the scrolling region, which is where these belong.
  //
  // Found by a QA sweep of tasks 205 and 206 TOGETHER: each was correct alone, and neither test
  // mounted them nested. The RN doubles are pass-throughs, so no render test can observe the real
  // clipping — the oracle has to be structural.
  const offenders: string[] = [];
  for (const [path, text] of files) {
    if (!/<AppShell/.test(text) || !/\bscrollable\b/.test(text)) continue;
    if (!/<ConfirmSheet/.test(text)) continue;
    // In the overlay slot the tag follows `overlay={`; as a child it does not.
    const viaOverlay = /overlay=\{[\s\S]{0,400}?<ConfirmSheet/.test(text);
    if (!viaOverlay) offenders.push(relative(REPO_ROOT, path));
  }
  expect(
    offenders,
    'These scrollable screens render a <ConfirmSheet> as an AppShell CHILD. Inside the ScrollView its ' +
      'absolute box spans the scrollable height and its buttons fall below the viewport — pass it to ' +
      "AppShell's `overlay` slot instead.",
  ).toEqual([]);
});

test('the ConfirmSheet detector sees the screens that actually have one', () => {
  // Denominator for the check above: if the scan stopped finding ConfirmSheet screens at all, the
  // assertion would pass over an empty set — green for the wrong reason.
  const withSheet = [...files].filter(
    ([, text]) => /<AppShell/.test(text) && /<ConfirmSheet/.test(text),
  );
  expect(withSheet.length).toBeGreaterThanOrEqual(3);
});
