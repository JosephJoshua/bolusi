// Catalog constants + loaders (07-i18n §3.3). The checked-in catalogs/<namespace>/{id,en}.json
// files are the CANONICAL i18n source and the review surface — hand-edited, with no upstream doc:
// task 191 retired the ai-docs/ui-labels.md → JSON seed and its three round-trip gates, so there is
// one representation, not a doc the JSON must be kept in lockstep with. gen.mjs codegens the runtime
// TS from these files; check.mjs runs the property gates over them.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(HERE, '..');
export const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
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

/** Locales the catalogs carry. `zh` is scaffold-only — no catalog files (07-i18n §1). */
export const SEEDED_LOCALES = ['id', 'en'];

/**
 * The reserved-namespace catalogs (packages/i18n/catalogs/<namespace>/{id,en}.json) as gate input.
 * @returns {import('./gates.mjs').CatalogSource[]}
 */
export function loadReservedCatalogs() {
  const sources = [];
  for (const namespace of RESERVED_NAMESPACES) {
    for (const locale of SEEDED_LOCALES) {
      const path = join(CATALOG_ROOT, namespace, `${locale}.json`);
      if (!existsSync(path)) continue;
      sources.push({
        id: relative(REPO_ROOT, path),
        namespace,
        locale,
        isModule: false,
        tree: JSON.parse(readFileSync(path, 'utf8')),
      });
    }
  }
  return sources;
}

/**
 * Module-owned catalogs (07-i18n §3.3): packages/modules/<id>/i18n/{id,en}.json. The collision gate
 * must see them so a module cannot claim a reserved namespace, and the key-grammar gate lints them —
 * which is the ONLY grammar check a module namespace (e.g. `notes.*`) gets, since the reserved
 * catalogs never carry module keys. `notes/i18n` ships today; more land with their modules.
 * @returns {import('./gates.mjs').CatalogSource[]}
 */
export function loadModuleCatalogs() {
  const sources = [];
  const modulesRoot = join(REPO_ROOT, 'packages', 'modules');
  if (!existsSync(modulesRoot)) return sources;

  for (const entry of readdirSync(modulesRoot)) {
    const i18nDir = join(modulesRoot, entry, 'i18n');
    if (!existsSync(i18nDir) || !statSync(i18nDir).isDirectory()) continue;
    for (const file of readdirSync(i18nDir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(i18nDir, file);
      sources.push({
        id: relative(REPO_ROOT, path),
        namespace: entry,
        locale: file.replace(/\.json$/, ''),
        isModule: true,
        tree: JSON.parse(readFileSync(path, 'utf8')),
      });
    }
  }
  return sources;
}
