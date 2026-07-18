// The `notes` i18n catalog completeness gate (04 §8 box 7; 07-i18n §3.3).
//
// The repo's `pnpm i18n:check` validates module catalogs for key GRAMMAR, id↔en PARITY, COLLISION
// and ICU — but it does NOT seed-parity-check module-owned rows against ui-labels.md (the gap task
// 30 documented: `checkSeedParity` covers reserved namespaces only). So THIS is the check that the
// notes catalog carries EXACTLY the `notes.*` rows from ui-labels.md, in BOTH locales, with the
// EXACT strings, no missing/extra keys. ui-labels.md is the single oracle — the catalog is asserted
// against the doc, not against a hand-transcribed expectation that could drift with it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_LABELS = join(HERE, '../../../ai-docs/ui-labels.md');
const CATALOG_DIR = join(HERE, '../notes/i18n');

/** Parse the `notes.*` rows from ui-labels.md → `{ key: {id, en} }`. */
function seedFromDoc(): Map<string, { id: string; en: string }> {
  const rows = new Map<string, { id: string; en: string }>();
  for (const line of readFileSync(UI_LABELS, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*`(notes\.[^`]+)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (m) rows.set(m[1]!, { id: m[2]!, en: m[3]! });
  }
  return rows;
}

/** Flatten a nested catalog tree → `{ 'notes.a.b': value }` (the namespace prefix is added here,
 *  since 07-i18n §3.3 keeps it OUT of the file). */
function flattenCatalog(locale: 'id' | 'en'): Map<string, string> {
  const tree = JSON.parse(readFileSync(join(CATALOG_DIR, `${locale}.json`), 'utf8')) as unknown;
  const out = new Map<string, string>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.set(path, node);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) walk(v, path === '' ? k : `${path}.${k}`);
    }
  };
  walk(tree, '');
  return new Map([...out].map(([k, v]) => [`notes.${k}`, v]));
}

describe('notes i18n catalogs (04 §8 box 7)', () => {
  const seed = seedFromDoc();

  test('ui-labels.md carries the notes.* rows the harness expects (denominator, T-14)', () => {
    // A non-zero, exact count: if the parse read zero rows (a doc format change), every comparison
    // below would trivially pass over empty sets. 11 notes.* rows ship today (ui-labels.md §notes).
    expect(seed.size).toBe(11);
  });

  for (const locale of ['id', 'en'] as const) {
    test(`${locale}.json has EXACTLY the notes.* keys from ui-labels — no missing, no extra`, () => {
      const catalog = flattenCatalog(locale);
      const seedKeys = [...seed.keys()].sort();
      const catalogKeys = [...catalog.keys()].sort();
      // Exact key-set equality both ways catches a missing key AND an extra one — a catalog that
      // carried a key the doc dropped would be an orphaned string nobody owns (07-i18n §3.3).
      expect(catalogKeys).toStrictEqual(seedKeys);
    });

    test(`${locale}.json values match ui-labels.md byte-for-byte (smart quotes, em-dash)`, () => {
      const catalog = flattenCatalog(locale);
      for (const [key, pair] of seed) {
        expect(catalog.get(key), `${key} (${locale})`).toBe(pair[locale]);
      }
    });
  }
});
