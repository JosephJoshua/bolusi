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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) out.push(path);
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

/** Repo-local modules this file imports, resolved to files in the scanned set. */
function localImports(path: string, text: string): string[] {
  const out: string[] = [];
  for (const spec of text.matchAll(/from\s*['"](\.[^'"]*)['"]/g)) {
    const target = spec[1];
    if (target === undefined) continue;
    const base = resolve(dirname(path), target.replace(/\.js$/, ''));
    for (const candidate of [`${base}.tsx`, join(base, 'index.tsx')]) {
      if (files.has(candidate)) out.push(candidate);
      else if (existsSync(candidate) && !files.has(candidate))
        files.set(candidate, readFileSync(candidate, 'utf8'));
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
