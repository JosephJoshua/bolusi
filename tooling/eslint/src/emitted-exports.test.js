// Task 57 — no package may re-export a type it does not EMIT (CLAUDE.md §2.11 / testing-guide
// T-14, T-14c, T-16).
//
// THE BUG THIS GUARDS AGAINST (task 39, the worst instance this project has shipped). A package's
// SOURCE re-export resolves fine — `packages/db-server/src/index.ts` said
// `export type { DB } from './generated/db.js'` and `src/generated/db.d.ts` existed as an INPUT
// declaration. But `tsc` does not copy an input `.d.ts` into `outDir`, so `dist/generated/` was
// never emitted, while `dist/index.d.ts` still carried the re-export. That re-export DANGLED:
// TypeScript resolved the missing module to `any`, and every consumer of `@bolusi/db-server`
// silently typechecked against an untyped `DB`. All of `apps/server` compiled against `any` for
// weeks with a green `tsc`, because there was nothing to check — the type system itself checking
// nothing across an entire application, the least-questioned signal in the repo.
//
// WHY A LINT RULE CANNOT SEE THIS, AND THIS TEST CAN. The defect exists ONLY in the built
// artifact. At the source level the re-export resolves (to the input `.d.ts`); ESLint lints source
// and never reads `dist/`. Only a check that reads the EMITTED `.d.ts` — after `tsc -b` — can see a
// re-export whose target was not emitted. `pnpm test` runs `tsc -b && vitest run`, so `dist/` is
// fresh when this file runs. If it is run without a build the denominator guards below fail loud
// (a missing/empty `dist/` reports zero, never a false green — T-14c).
//
// SCOPE vs its siblings (§2.8, one implementation each):
//   - `apps/server/test/db-types-reach-consumers.test.ts` (task 39) is the DB-SPECIFIC guard: it
//     proves the `DB` type reaches consumers. This file is the REPO-WIDE STRUCTURAL question:
//     does ANY package promise, in its emitted output or its `package.json` surface, a type it
//     does not emit? Different question.
//   - `packages/db-server/test/export-surface.test.ts` pins db-server's export NAMES. Orthogonal:
//     this checks that every emitted re-export RESOLVES, whatever the names are.
//
// WHAT IS FORBIDDEN (RED):
//   A) an input `.d.ts` under any workspace `src/` (the exact task-39 seed — an input decl `tsc`
//      will not copy to `outDir`);
//   B) a RELATIVE module specifier (`./x`, `../x`) in an emitted `.d.ts` — in `export … from`,
//      `import … from`, or an inline `import('…')` type — that does not resolve to an emitted
//      sibling TYPE file (`./foo.js` must have an emitted `./foo.d.ts`, not merely a `./foo.js`);
//   C) a `package.json` `exports` / `types` / `typings` / `main` / `module` target that names a
//      file not present on disk.
//
// WHAT IS ALLOWED (GREEN) — the rule must not false-positive on these:
//   - BARE / package specifiers (`@bolusi/schemas`, `kysely`, `node:fs`) are never checked: they
//     resolve through another package's own `exports` map, not this package's emit. This is why
//     task 77's SANCTIONED re-export — `packages/i18n/src/locale.ts` doing
//     `export { …Locale vocabulary… } from '@bolusi/schemas'` — stays green: `@bolusi/schemas` is
//     a real emitted package. Every legitimate cross-package barrel is the same shape.
//   - a relative in-package barrel whose target IS emitted (the overwhelming majority).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// pnpm-workspace.yaml globs: apps/*, packages/*, tooling/*. Replicated here; the discovery below
// asserts it found the workspaces it MUST, so a broken glob cannot silently shrink the denominator.
const WORKSPACE_ROOTS = ['apps', 'packages', 'tooling'];

// The sweep must have SEEN these — if discovery breaks and returns a starved set, fail loud (T-14).
const REQUIRED_WORKSPACES = [
  '@bolusi/core',
  '@bolusi/db-server',
  '@bolusi/i18n',
  '@bolusi/schemas',
  '@bolusi/server',
];

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested against synthetic fixtures below, then run against the real tree).
// ---------------------------------------------------------------------------------------------

/** Recursively list files under `dir` matching `predicate`, skipping node_modules. */
function walkFiles(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const isDeclaration = (file) => file.endsWith('.d.ts') && !file.endsWith('.d.ts.map');

/** Discover workspace package dirs + names from the pnpm-workspace globs. */
function discoverWorkspaces() {
  const found = [];
  for (const root of WORKSPACE_ROOTS) {
    const rootDir = join(REPO_ROOT, root);
    let entries;
    try {
      entries = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(rootDir, entry.name);
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      found.push({ name: pkg.name, dir, pkg });
    }
  }
  return found;
}

/**
 * All RELATIVE module specifiers referenced by an emitted `.d.ts`: `export … from`, `import … from`,
 * and inline `import('…')` type nodes. Uses the TypeScript AST — a regex counts `from '…'` inside a
 * JSDoc example or a string literal as a real specifier (proven during calibration), so it cannot
 * be trusted for a guard.
 */
function relativeSpecifiersOf(filePath, text) {
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const specifiers = [];
  const record = (node) => {
    if (node && ts.isStringLiteral(node) && node.text.startsWith('.')) specifiers.push(node.text);
  };
  const visit = (node) => {
    if ((ts.isExportDeclaration(node) || ts.isImportDeclaration(node)) && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Does the TYPE for `spec` (resolved from `fromDir`) exist as an emitted declaration? A `./foo.js`
 * re-export needs an emitted `./foo.d.ts`; a bare `./foo.js` with no `.d.ts` sibling is exactly the
 * task-39 dangle (types resolve to `any`), so the `.js` itself never satisfies a code specifier.
 */
function emittedTypeExists(fromDir, spec) {
  const abs = resolve(fromDir, spec);
  const candidates = [];
  if (/\.jsx?$/.test(spec)) candidates.push(abs.replace(/\.jsx?$/, '.d.ts'));
  else if (/\.mjs$/.test(spec))
    candidates.push(abs.replace(/\.mjs$/, '.d.mts'), abs.replace(/\.mjs$/, '.d.ts'));
  else if (/\.cjs$/.test(spec))
    candidates.push(abs.replace(/\.cjs$/, '.d.cts'), abs.replace(/\.cjs$/, '.d.ts'));
  else if (/\.d\.[mc]?ts$/.test(spec)) candidates.push(abs);
  else if (/\.json$/.test(spec)) candidates.push(abs);
  else candidates.push(`${abs}.d.ts`, `${abs}.d.mts`, `${abs}.d.cts`, join(abs, 'index.d.ts'));
  return candidates.some((c) => existsSync(c));
}

/** Every dangling relative specifier across a set of emitted `.d.ts` files. */
function danglingReExports(declarationFiles) {
  const dangling = [];
  let specifiersChecked = 0;
  for (const file of declarationFiles) {
    const text = readFileSync(file, 'utf8');
    for (const spec of relativeSpecifiersOf(file, text)) {
      specifiersChecked += 1;
      if (!emittedTypeExists(dirname(file), spec)) dangling.push({ file, spec });
    }
  }
  return { dangling, specifiersChecked };
}

/** Flatten every string target reachable through a `package.json` `exports` value. */
function exportsTargets(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) exportsTargets(item, out);
  else if (typeof node === 'object')
    for (const value of Object.values(node)) exportsTargets(value, out);
  return out;
}

/** All package-surface targets a `package.json` promises: exports tree + main/module/types/typings. */
function surfaceTargets(pkg) {
  const targets = exportsTargets(pkg.exports);
  for (const key of ['main', 'module', 'types', 'typings']) {
    if (typeof pkg[key] === 'string') targets.push(pkg[key]);
  }
  // Only relative-path targets are on disk in this package; a bare specifier is a re-export to
  // another package (none exist today, but stay correct if one is added).
  return targets.filter((t) => t.startsWith('.'));
}

// ---------------------------------------------------------------------------------------------
// FALSIFICATION — the guard's own logic, proven RED and GREEN against synthetic fixtures on every
// run (§2.11 / T-14b: a guard nobody has watched fail is not a guard, and one that is always-green
// is worse). The live-tree tests below can only ever pass on a clean tree; THESE prove detection.
// ---------------------------------------------------------------------------------------------

describe('the checker detects a dangling re-export (falsification)', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'task57-emit-'));
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const writeDist = (name, files) => {
    const distDir = join(fixtureRoot, name, 'dist');
    for (const [rel, body] of Object.entries(files)) {
      const full = join(distDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return walkFiles(distDir, isDeclaration);
  };

  test('RED: a re-export of an UNEMITTED sibling is flagged (reproduces task 39)', () => {
    // `index.d.ts` re-exports `./generated/db.js`, but `generated/` was never emitted — exactly
    // the shape of the original bug.
    const files = writeDist('broken', {
      'index.d.ts':
        "export type { DB } from './generated/db.js';\nexport { forTenant } from './for-tenant.js';\n",
      'for-tenant.d.ts': 'export declare const forTenant: () => void;\n',
    });
    const { dangling, specifiersChecked } = danglingReExports(files);
    expect(specifiersChecked).toBe(2);
    expect(dangling).toEqual([
      { file: join(fixtureRoot, 'broken', 'dist', 'index.d.ts'), spec: './generated/db.js' },
    ]);
  });

  test('GREEN: the same re-export resolves once the sibling is emitted (T-14b, not always-red)', () => {
    const files = writeDist('fixed', {
      'index.d.ts': "export type { DB } from './generated/db.js';\n",
      'generated/db.d.ts': 'export interface DB {}\n',
    });
    const { dangling, specifiersChecked } = danglingReExports(files);
    expect(specifiersChecked).toBe(1);
    expect(dangling).toEqual([]);
  });

  test('GREEN: a bare cross-package re-export is not checked (task 77 i18n→schemas shape)', () => {
    // `@bolusi/schemas` resolves through ITS OWN exports map, not this package's emit. The sweep
    // must never flag it — this is the sanctioned re-export the whole task must not break.
    const files = writeDist('barrel', {
      'index.d.ts':
        "export { LOCALES, type Locale } from '@bolusi/schemas';\nexport { INTL } from './locale.js';\n",
      'locale.d.ts': 'export declare const INTL: string;\n',
    });
    const { dangling, specifiersChecked } = danglingReExports(files);
    // only the ONE relative specifier is counted; the bare `@bolusi/schemas` is skipped.
    expect(specifiersChecked).toBe(1);
    expect(dangling).toEqual([]);
  });

  test('RED: an inline import() type pointing at an unemitted module is flagged', () => {
    const files = writeDist('inline', {
      'index.d.ts': "export declare const x: import('./gone.js').Thing;\n",
    });
    const { dangling } = danglingReExports(files);
    expect(dangling).toEqual([
      { file: join(fixtureRoot, 'inline', 'dist', 'index.d.ts'), spec: './gone.js' },
    ]);
  });

  test('a JSDoc code example is NOT parsed as a specifier (a regex sweep would false-positive here)', () => {
    const files = writeDist('jsdoc', {
      'index.d.ts':
        "/**\n * ```ts\n * export { y } from './does-not-exist.js';\n * ```\n */\nexport declare const y: number;\n",
    });
    const { dangling, specifiersChecked } = danglingReExports(files);
    expect(specifiersChecked).toBe(0);
    expect(dangling).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// LIVE TREE — the actual gate. Denominators are asserted so a blind sweep (empty/missing dist,
// broken glob) fails loud instead of reporting a confident zero.
// ---------------------------------------------------------------------------------------------

describe('the whole tree emits every type it promises (task 57)', () => {
  const workspaces = discoverWorkspaces();

  test('discovery found the workspaces it must (denominator anchor, T-14)', () => {
    const names = workspaces.map((w) => w.name);
    for (const required of REQUIRED_WORKSPACES) expect(names).toContain(required);
    // 13 workspaces today (apps: mobile, server; tooling: eslint, tsconfig; packages: 9).
    expect(workspaces.length).toBeGreaterThanOrEqual(13);
  });

  test('A) no input `.d.ts` lives under any workspace `src/` (the task-39 seed)', () => {
    let srcTreesScanned = 0;
    const offenders = [];
    for (const { dir } of workspaces) {
      const srcDir = join(dir, 'src');
      if (!existsSync(srcDir)) continue;
      srcTreesScanned += 1;
      for (const file of walkFiles(srcDir, isDeclaration)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    // If we scanned zero src trees the check saw nothing — that is not a pass (T-14).
    expect(srcTreesScanned).toBeGreaterThan(0);
    expect(
      offenders,
      `input .d.ts under src/ — tsc will not emit these; re-exports of them dangle`,
    ).toEqual([]);
  });

  test('B) every relative re-export in an emitted `.d.ts` resolves to an emitted type', () => {
    const declarationFiles = [];
    for (const { dir } of workspaces) {
      const distDir = join(dir, 'dist');
      if (existsSync(distDir)) declarationFiles.push(...walkFiles(distDir, isDeclaration));
    }
    // A missing/empty dist means the build did not run — refuse to report green over nothing.
    expect(
      declarationFiles.length,
      'no emitted .d.ts found — run `tsc -b` first (pnpm test does). This gate reads build output.',
    ).toBeGreaterThan(0);

    const { dangling, specifiersChecked } = danglingReExports(declarationFiles);
    expect(
      specifiersChecked,
      'zero relative specifiers checked — the sweep is blind',
    ).toBeGreaterThan(0);

    // Concrete anchor: the sweep MUST have seen db-server's re-export of the generated types — the
    // exact site of the original bug. If task 39's emit shape changes so this specifier vanishes,
    // fail loud and update consciously (a silent disappearance is how this class hides).
    const dbServerIndex = declarationFiles.find((f) =>
      f.endsWith(join('db-server', 'dist', 'index.d.ts')),
    );
    expect(dbServerIndex, 'db-server/dist/index.d.ts not scanned').toBeDefined();
    expect(relativeSpecifiersOf(dbServerIndex, readFileSync(dbServerIndex, 'utf8'))).toContain(
      './generated/db.js',
    );

    const report = dangling.map((d) => `${relative(REPO_ROOT, d.file)} → ${d.spec}`);
    expect(report, 'emitted .d.ts re-exports a type its package never emitted').toEqual([]);
  });

  test('C) every package.json exports/types/main/module target exists on disk', () => {
    let targetsChecked = 0;
    const missing = [];
    for (const { dir, pkg } of workspaces) {
      for (const target of surfaceTargets(pkg)) {
        targetsChecked += 1;
        if (!existsSync(resolve(dir, target))) {
          missing.push(`${pkg.name}: ${target}`);
        }
      }
    }
    expect(
      targetsChecked,
      'zero package-surface targets checked — the sweep is blind',
    ).toBeGreaterThan(0);
    expect(missing, 'package.json promises a file it does not emit').toEqual([]);
  });
});
