// The notes module's screen key surface (`NotesKey` / `NOTES_KEYS`) is pinned to its SHIPPED catalog
// here — the parity assertion the `NOTES_KEYS` JSDoc promises
// (packages/modules/src/notes/screens/i18n.ts).
//
// WHY THIS PIN IS LOAD-BEARING, AND WHY IT LIVES IN apps/mobile. Screens translate with `tn(key)`,
// not `t(key)`: the 07-i18n §7.3 extraction gate only scans `t('...')` call sites, so a
// `tn('notes.x')` whose key has no catalog entry is invisible to it. `NotesKey` types the call, but
// the type cannot know whether the shipped catalog actually carries the key — this test is the only
// thing that fails when the typed surface and the runtime catalog drift apart. `NOTES_KEYS` lives
// behind the RN-only `@bolusi/modules/notes/screens` surface (08 §3.2), importable ONLY from
// apps/mobile, so this is the one package that can assert it against the catalog JSON.
//
// The catalog VALUES are canonical (07-i18n §3.1; task 191 retired the ui-labels.md doc oracle) —
// there is no external source to byte-compare them against. `notes-catalog-boot.test.tsx` proves
// they resolve to the shipped Indonesian strings at runtime; THIS test proves the KEY SET matches
// the module's typed surface, in both locales.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTES_KEYS } from '@bolusi/modules/notes/screens';
import { describe, expect, test } from 'vitest';

// Resolve the shipped catalog dir from THIS file's location. Pass the STRING `import.meta.url` to
// fileURLToPath, never a `new URL(...)`: apps/mobile's DOM/RN lib types the global `URL`
// incompatibly with node's `import("url").URL`, so a `URL` object fails `tsc --noEmit` in this
// package (TS2345) even though it runs. String path math is lib-agnostic.
const CATALOG_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/modules/notes/i18n',
);

/** Flatten a nested catalog tree → the fully-qualified `notes.*` keys it ships (07-i18n §3.3 keeps
 *  the namespace prefix OUT of the file, so it is added here). */
function catalogKeys(locale: 'id' | 'en'): string[] {
  const tree = JSON.parse(readFileSync(join(CATALOG_DIR, `${locale}.json`), 'utf8')) as unknown;
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push(`notes.${path}`);
      return;
    }
    if (typeof node === 'object' && node !== null)
      for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`);
  };
  walk(tree, '');
  return out;
}

describe('the notes catalog matches the module typed key surface (NOTES_KEYS)', () => {
  test('NOTES_KEYS is non-empty — the denominator every comparison below divides by (T-14)', () => {
    // A typed const cannot be "starved" by a format change the way a doc parse could, but an
    // accidental truncation to `[]` would make every set-equality below pass over empty sets. The
    // floor sits below today's surface (14 keys) so adding a key never trips it; a collapse does.
    expect(NOTES_KEYS.length).toBeGreaterThanOrEqual(10);
  });

  for (const locale of ['id', 'en'] as const) {
    test(`${locale}.json ships EXACTLY the NOTES_KEYS surface — no missing key, no orphan`, () => {
      // Both-way equality: a missing key means a `tn()` call renders the humanized leaf at runtime
      // (the extraction gate never sees `tn`); an extra key is a catalog string no screen owns.
      expect(catalogKeys(locale).sort()).toStrictEqual([...NOTES_KEYS].sort());
    });
  }
});
