/**
 * A screen may not put a `List` inside a scrolling `AppShell` content slot (task 206).
 *
 * WHY THIS IS A SOURCE-LEVEL GUARD AND NOT A RENDER TEST. `List` renders a `FlatList`, and RN
 * refuses to nest a same-orientation `VirtualizedList` inside a plain `ScrollView` — it logs
 * "VirtualizedLists should never be nested inside plain ScrollViews with the same orientation
 * because it can break windowing" and `onEndReached`/windowing stop working. None of that is
 * observable here: `packages/ui/test/doubles/react-native.tsx` replaces BOTH `ScrollView` and
 * `FlatList` with pass-through host nodes, so no test that mounts a screen can ever see it. That is
 * exactly how the original task-206 fix shipped a ScrollView around all seven List-bearing screens
 * with 1,362 tests green — found only by a reviewer reading RN's source.
 *
 * So the oracle is the SOURCE. It is coarse (a file-level grep, not a JSX-tree walk), which means it
 * can over-report if a file ever holds two unrelated AppShell screens — a false RED, which is the
 * safe direction, and the message says how to resolve it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

const screens = ROOTS.flatMap((root) => collect(join(REPO_ROOT, root), []))
  .map((path) => ({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }))
  .filter((file) => file.text.includes('<AppShell'));

test('the AppShell screen scan finds screens at all', () => {
  // T-14 denominator. If the walk breaks, every assertion below passes over an empty set and this
  // file becomes a green that checks nothing — the failure mode the guard exists to prevent.
  expect(screens.length).toBeGreaterThanOrEqual(10);
});

test('no screen opts into AppShell scrolling while rendering a List', () => {
  const offenders = screens
    .filter((file) => /\bscrollable\b/.test(file.text) && /<List[\s/>]/.test(file.text))
    .map((file) => file.path);

  expect(
    offenders,
    `These screens pass \`scrollable\` to AppShell AND render a <List>. A List is a FlatList, and RN ` +
      `breaks windowing when one is nested in a same-orientation ScrollView. Such a screen already ` +
      `scrolls through its list — drop \`scrollable\`. (If the file holds two separate screens and ` +
      `only the List-free one scrolls, split them so this stays checkable.)`,
  ).toEqual([]);
});
