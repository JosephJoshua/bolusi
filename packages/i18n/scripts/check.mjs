// `pnpm i18n:check` — the 07-i18n §7.3 gate runner. All filesystem I/O lives here; the gates
// themselves are pure functions in gates.mjs so each is proven by a failing fixture in test/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  checkCollision,
  checkErrorCodeCoverage,
  checkExtraction,
  checkIcuSubset,
  checkKeyGrammar,
  flattenSource,
  checkParity,
  checkSeedKeyGrammar,
  SEED_MIN_ROWS,
} from './gates.mjs';
import { KEYS_PATH, RESOURCES_PATH, renderAll } from './gen.mjs';
import {
  CATALOG_ROOT,
  REPO_ROOT,
  RESERVED_NAMESPACES,
  SEEDED_LOCALES,
  UI_LABELS_PATH,
  parseUiLabels,
  seedFromDoc,
  serializeCatalog,
} from './seed.mjs';

/** Directories scanned for `t()` call sites by the extraction gate. */
const SOURCE_ROOTS = ['apps', 'packages/modules', 'packages/ui'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.expo', 'coverage', 'android', 'ios']);
/**
 * A whole-key `t('a.b.c')` call site.
 *
 * The `(?!\s*\+)` tail excludes the derived-key calls the spec *mandates* —
 * `t('core.errors.' + code)` / `t('core.rejection.' + code)` (07-i18n §3.1, §4.2, §4.3). Without
 * it the literal is captured as the key `core.errors.`, which is a prefix, not a key, and the
 * extraction gate reports it missing from the catalog forever. Those keys are not unchecked:
 * the error-code coverage gate below enumerates them from the code registry, which is the whole
 * point of deriving them.
 */
const T_CALL_RE = /\bt\(\s*'([a-zA-Z][\w.]*)'(?!\s*\+)/g;

/** @returns {import('./gates.mjs').CatalogSource[]} */
function loadReservedCatalogs() {
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
 * Module-owned catalogs (07-i18n §3.3): packages/modules/<id>/i18n/{id,en}.json. None exist
 * yet — the notes catalog lands with its module — but the collision gate must see them the
 * moment they do, which is exactly when a module could claim a reserved namespace.
 * @returns {import('./gates.mjs').CatalogSource[]}
 */
function loadModuleCatalogs() {
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

/**
 * @param {string} dir
 * @param {string[]} out
 */
function collectSourceFiles(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectSourceFiles(path, out);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

/** @returns {string[]} every key referenced by a `t('...')` call in app/module/ui code */
function collectUsedKeys() {
  const keys = new Set();
  for (const root of SOURCE_ROOTS) {
    for (const file of collectSourceFiles(join(REPO_ROOT, root), [])) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(T_CALL_RE)) keys.add(match[1]);
    }
  }
  return [...keys];
}

/**
 * Gate: the checked-in catalogs still match ai-docs/ui-labels.md verbatim (07-i18n §7.1.5).
 * @returns {string[]}
 */
function checkSeedParity() {
  const expected = seedFromDoc();
  const errors = [];
  for (const [namespace, byLocale] of Object.entries(expected)) {
    for (const [locale, tree] of Object.entries(byLocale)) {
      const path = join(CATALOG_ROOT, namespace, `${locale}.json`);
      if (!existsSync(path)) {
        errors.push(
          `catalogs/${namespace}/${locale}.json is missing; run \`pnpm --filter @bolusi/i18n i18n:seed\``,
        );
        continue;
      }
      if (readFileSync(path, 'utf8') !== serializeCatalog(tree)) {
        errors.push(
          `catalogs/${namespace}/${locale}.json has drifted from ai-docs/ui-labels.md — change the doc first, then run \`pnpm --filter @bolusi/i18n i18n:seed\` (07-i18n §7.1.5)`,
        );
      }
    }
  }
  return errors;
}

/**
 * Gate: the generated key union and merged resources are in sync with the catalogs
 * (07-i18n §3.3, §3.4).
 * @returns {string[]}
 */
async function checkGenerated() {
  const rendered = await renderAll();
  const errors = [];
  for (const [path, expected] of [
    [KEYS_PATH, rendered.keys],
    [RESOURCES_PATH, rendered.resources],
  ]) {
    const name = relative(REPO_ROOT, path);
    if (!existsSync(path)) {
      errors.push(`${name} is missing; run \`pnpm --filter @bolusi/i18n i18n:gen\``);
    } else if (readFileSync(path, 'utf8') !== expected) {
      errors.push(`${name} is stale; run \`pnpm --filter @bolusi/i18n i18n:gen\``);
    }
  }
  return errors;
}

async function main() {
  const sources = [...loadReservedCatalogs(), ...loadModuleCatalogs()];
  const extraction = checkExtraction(collectUsedKeys(), sources);
  const seedRows = parseUiLabels(readFileSync(UI_LABELS_PATH, 'utf8'));

  /** @type {{ name: string, errors: string[] }[]} */
  const results = [
    { name: 'seed parity (ui-labels.md → catalogs)', errors: checkSeedParity() },
    { name: 'key grammar (ui-labels.md rows)', errors: checkSeedKeyGrammar(seedRows) },
    { name: 'key grammar (catalogs)', errors: checkKeyGrammar(sources) },
    { name: 'collision', errors: checkCollision(sources) },
    { name: 'parity (id ↔ en)', errors: checkParity(sources) },
    { name: 'ICU restricted subset', errors: checkIcuSubset(sources) },
    { name: 'error-code coverage', errors: checkErrorCodeCoverage(sources) },
    { name: 'extraction', errors: extraction.errors },
    { name: 'generated key union + resources', errors: await checkGenerated() },
  ];

  let failed = 0;
  for (const { name, errors } of results) {
    if (errors.length === 0) {
      console.log(`i18n:check: PASS  ${name}`);
      continue;
    }
    failed += 1;
    console.error(`i18n:check: FAIL  ${name}`);
    for (const error of errors) console.error(`  - ${error}`);
  }

  // Unused catalog keys are a warning, never a failure (07-i18n §7.3): the catalog legitimately
  // leads the UI here — most v0 screens have not been built yet.
  if (extraction.warnings.length > 0) {
    console.log(
      `i18n:check: WARN  ${extraction.warnings.length} catalog key(s) not yet referenced by a t() call`,
    );
  }

  // State the denominator, don't just assert it (testing-guide T-14): a reader of this log can
  // see how many keys the grammar gate actually read, rather than trusting a bare PASS.
  console.log(
    `i18n:check: grammar-linted ${seedRows.length} ui-labels.md row(s) and ` +
      `${new Set(sources.flatMap((s) => flattenSource(s).map((e) => e.key))).size} catalog key(s) ` +
      `(seed-row floor ${SEED_MIN_ROWS})`,
  );

  if (failed > 0) {
    console.error(`i18n:check: ${failed} gate(s) failed (07-i18n §7.3)`);
    process.exit(1);
  }
  console.log(`i18n:check: all ${results.length} gates passed`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
