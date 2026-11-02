// Each module's screen key surface (`NOTES_KEYS`, `REPAIR_KEYS`) is pinned to its SHIPPED catalogs
// here. Screens translate with `tn(key)`, and the key union types the call, but only this test
// fails when the typed surface and the runtime catalog drift apart: a missing key would render the
// humanized leaf at runtime, an extra key is a string no screen owns. The key lists live behind the
// RN-only `*/screens` surfaces (08 §3.2), importable only from apps/mobile, so the pin lives here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTES_KEYS } from '@bolusi/modules/notes/screens';
import { APPROVALS_KEYS } from '@bolusi/modules/approvals/screens';
import { MONEY_KEYS } from '@bolusi/modules/money/screens';
import { PURCHASING_KEYS } from '@bolusi/modules/purchasing/screens';
import { REPAIR_KEYS } from '@bolusi/modules/repair/screens';
import { describe, expect, test } from 'vitest';

// Resolve the shipped catalog dir from THIS file's location. Pass the STRING `import.meta.url` to
// fileURLToPath, never a `new URL(...)`: apps/mobile's DOM/RN lib types the global `URL`
// incompatibly with node's `import("url").URL`, so a `URL` object fails `tsc --noEmit` in this
// package (TS2345) even though it runs. String path math is lib-agnostic.
const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/modules');

/** Flatten a nested catalog tree → the fully-qualified `<module>.*` keys it ships (07-i18n §3.3 keeps
 *  the namespace prefix OUT of the file, so it is added here). */
function catalogKeys(module: string, locale: 'id' | 'en'): string[] {
  const file = join(MODULES_DIR, module, 'i18n', `${locale}.json`);
  const tree = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push(`${module}.${path}`);
      return;
    }
    if (typeof node === 'object' && node !== null)
      for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`);
  };
  walk(tree, '');
  return out;
}

const MODULES = [
  { module: 'notes', keys: NOTES_KEYS },
  { module: 'repair', keys: REPAIR_KEYS },
  { module: 'money', keys: MONEY_KEYS },
  { module: 'approvals', keys: APPROVALS_KEYS },
  { module: 'purchasing', keys: PURCHASING_KEYS },
] as const;

describe.each(MODULES)('the $module catalog matches its typed key surface', ({ module, keys }) => {
  test('the key list is non-empty, the denominator every comparison divides by (T-14)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  for (const locale of ['id', 'en'] as const) {
    test(`${locale}.json ships exactly the typed keys: no missing key, no orphan`, () => {
      expect(catalogKeys(module, locale).sort()).toStrictEqual([...keys].sort());
    });
  }
});
