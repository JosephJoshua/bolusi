// Catalog seed (07-i18n §3.3, §7.1.5): ai-docs/ui-labels.md is the source of truth and the
// review surface. This script parses its tables and emits catalogs/<namespace>/{id,en}.json,
// so a catalog value can never silently drift from the doc — check.mjs re-runs the parse and
// fails when the checked-in JSON differs (the seed-parity gate).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(HERE, '..');
export const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
export const UI_LABELS_PATH = join(REPO_ROOT, 'ai-docs', 'ui-labels.md');
export const CATALOG_ROOT = join(PACKAGE_ROOT, 'catalogs');

/** Reserved, platform-owned namespaces (07-i18n §3.1). */
export const RESERVED_NAMESPACES = [
  'core',
  'auth',
  'sync',
  'conflict',
  'media',
  'push',
  'permission',
  'role',
];

/** Locales the seed carries. `zh` is scaffold-only — no catalog files (07-i18n §1). */
export const SEEDED_LOCALES = ['id', 'en'];

// There is deliberately no deferred/parked-key list here (task 30). One used to exist, holding
// the three 2-segment keys that 07-i18n §3.1 forbids — but parking a key skips it in
// buildCatalogs, so it never reaches a catalog and the key-grammar gate, which reads catalogs,
// never saw it. `pnpm i18n:check` was green *because* the violating keys were hidden from the
// gate that exists to flag them (CLAUDE.md §2.11 — a guard whose failure mode is "silently
// checks nothing"). The keys were renamed in ui-labels.md instead. If a future row conflicts
// with the spec, let the gate fail and fix the doc — do not re-introduce a bypass.

const ROW_RE = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

/**
 * Parse every `| \`key\` | id | en |` table row out of ui-labels.md.
 * Header/separator rows carry no backticked first cell, so they never match.
 *
 * @param {string} markdown
 * @returns {{ key: string, id: string, en: string }[]}
 */
export function parseUiLabels(markdown) {
  /** @type {{ key: string, id: string, en: string }[]} */
  const rows = [];
  for (const line of markdown.split('\n')) {
    const match = ROW_RE.exec(line);
    if (!match) continue;
    const [, key, id, en] = match;
    rows.push({ key, id, en });
  }
  return rows;
}

/**
 * @param {Record<string, unknown>} target
 * @param {string[]} path
 * @param {string} value
 */
function setNested(target, path, value) {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    if (node[segment] === undefined) node[segment] = {};
    node = /** @type {Record<string, unknown>} */ (node[segment]);
  }
  node[path[path.length - 1]] = value;
}

/**
 * Group parsed rows into per-namespace, per-locale nested objects. The namespace segment is
 * stripped — it is re-added at merge time, never repeated inside the file (07-i18n §3.3).
 * Module-owned namespaces (e.g. `notes`) are skipped: each module owns its own catalog files.
 *
 * @param {{ key: string, id: string, en: string }[]} rows
 * @returns {Record<string, Record<string, Record<string, unknown>>>}
 */
export function buildCatalogs(rows) {
  /** @type {Record<string, Record<string, Record<string, unknown>>>} */
  const catalogs = {};
  for (const namespace of RESERVED_NAMESPACES) {
    catalogs[namespace] = {};
    for (const locale of SEEDED_LOCALES) catalogs[namespace][locale] = {};
  }

  for (const row of rows) {
    const segments = row.key.split('.');
    const namespace = segments[0];
    if (!RESERVED_NAMESPACES.includes(namespace)) continue;
    for (const locale of SEEDED_LOCALES) {
      setNested(catalogs[namespace][locale], segments.slice(1), row[locale]);
    }
  }
  return catalogs;
}

/** @returns {Record<string, Record<string, Record<string, unknown>>>} */
export function seedFromDoc() {
  return buildCatalogs(parseUiLabels(readFileSync(UI_LABELS_PATH, 'utf8')));
}

/** @param {unknown} value */
export function serializeCatalog(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const catalogs = seedFromDoc();
  let written = 0;
  for (const [namespace, byLocale] of Object.entries(catalogs)) {
    mkdirSync(join(CATALOG_ROOT, namespace), { recursive: true });
    for (const [locale, tree] of Object.entries(byLocale)) {
      writeFileSync(join(CATALOG_ROOT, namespace, `${locale}.json`), serializeCatalog(tree));
      written += 1;
    }
  }
  console.log(`i18n:seed: wrote ${written} catalog files from ai-docs/ui-labels.md`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
