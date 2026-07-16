// The 08 §5.6 build-prefix gate: every test script builds the cross-package dists it imports.
//
// WHAT THIS EXISTS TO PREVENT
// ---------------------------
// Packages are consumed from `dist/` (08 §4): a vitest lane importing another package's
// `@bolusi/*` entry resolves that package's `dist/`, with no src fallback and no alias. So a
// test script that does not build first reads WHATEVER WAS BUILT LAST — or nothing at all.
// Both failure modes are live:
//
//   cold (CI, fresh checkout): no dist -> "Failed to resolve entry for package @bolusi/core".
//     Loud, but it means the lane never ran. Measured on `test:rls` at task 55: 3 files failed
//     to load, and the run still reported "Tests 90 passed (90)" from the 12 files that do not
//     import core. The three that carry every real-driver claim contributed ZERO tests.
//   warm (local): a stale dist left by a prior `pnpm test`. The lane runs, green, against the
//     old bundle — while source maps still point stack traces at `src`, so it LOOKS live.
//     Measured on `test:rls` at task 55: task 46's 2^53 refusal deleted from `packages/core/src`
//     reported 10/10 GREEN on real PG 16.14; the same source with `dist` rebuilt went 1 red.
//     The only difference was `tsc -b`.
//
// §5.6 has been violated four times by four agents (task 32's `test:server`, task 24's mobile
// lane, and task 55's `test:rls` + `@bolusi/db-client`). A rule broken four times is not
// enforced, it is remembered badly. Hence a machine, not a convention.
//
// WHY THIS RESOLVES THE PROJECT GRAPH INSTEAD OF GREPPING FOR "tsc -b"
// --------------------------------------------------------------------
// Because the prefix being PRESENT does not mean it BUILDS anything, and that is not
// hypothetical: task 24 shipped `tsc -b && vitest run` in apps/mobile, where a bare `tsc -b`
// resolves apps/mobile/tsconfig.json — which has no `references` and cannot get any (§5.6
// forbids `composite` there). It compiled nothing and the lane stayed a fake green WITH the
// required prefix. Only `tsc -b ../..` (the root solution file) worked. A grep-shaped gate
// would have certified that bug, and would have been the ninth guard in this repo to go green
// for the wrong reason (CLAUDE.md §2.11). So: resolve what `tsc -b` actually reaches, follow
// `references` transitively, and ask whether the needed package's dist is among the output.
//
// This gate fails CLOSED on its own blindness: no test scripts, no dist-only packages, a vitest
// config whose project name it cannot read, or a `--project` it cannot map, are each a reported
// FAILURE rather than a vacuous green (§2.11 — a guard must assert its own coverage). The
// `--project` case was a live bug in this file: unmappable names were silently dropped, so the
// script was still COUNTED in the denominator while being checked against nothing.
//
// WHAT THIS GATE DOES NOT SEE — read before trusting a green
// ----------------------------------------------------------
// Import detection is a REGEX over source text, not a resolver. Each blind spot below was
// checked against this repo rather than guessed at, because an unverified limitations list is
// just another comment standing in for evidence:
//   - Dynamic `await import('@bolusi/x')` is NOT matched: the pattern wants `from`/`import`/
//     `require(` then whitespace-then-quote, and `import(` puts a paren in the way. LIVE
//     instance at packages/core/test/sync/loop.test.ts:278 — presently harmless only because
//     line 21 of that same file imports @bolusi/test-support statically, so the package is
//     detected anyway. Delete line 21 and this gate goes blind to it. Masked, not absent.
//   - Only .ts/.tsx/.mts/.cts are scanned. No live instance: the repo's only .js tests are
//     tooling/eslint's rule tests, whose `@bolusi/*` mentions are RuleTester `code:` FIXTURE
//     STRINGS, not imports (boundaries.test.js:86 etc.). That cuts both ways — naively adding
//     .js to the scan would read those fixtures as real imports and manufacture false alarms
//     against a package that imports nothing. Widen with a parser, not a bigger glob.
//   - `emits` is read from a tsconfig's OWN compilerOptions, so an `outDir` inherited purely
//     through `extends` would be misread. No instance today: every emitting project here is a
//     tsconfig.build.json declaring its own outDir.
// The first and third can only fail to NOTICE, never false-alarm. So a green here means "no
// violation among the imports this gate can see" — strictly weaker than "no violation".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Workspace globs from pnpm-workspace.yaml (§5.1); the root package is checked too. */
const WORKSPACE_DIRS = ['apps', 'packages', 'tooling'];

/** Source extensions whose imports can pull in a cross-package dist entry. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** Directories that never contain first-party source. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'generated']);

/**
 * Strips // and /* *\/ comments from JSONC (tsconfig files carry both), leaving string
 * literals intact — a naive strip would eat the "//" in a URL and corrupt the parse.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Trailing commas are legal in tsconfig and fatal to JSON.parse.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJsonc(file) {
  return JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
}

/**
 * True when a package's entry points resolve to `dist/` with no `src` fallback — i.e. importing
 * it from a test REQUIRES a prior build.
 * @param {any} pkgJson
 * @returns {boolean}
 */
export function isDistOnly(pkgJson) {
  const entry = JSON.stringify(pkgJson.exports ?? pkgJson.main ?? '');
  return entry.includes('dist') && !entry.includes('src');
}

/**
 * Every source file under a package, excluding build output and dependencies.
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(full);
      }
    }
  }
  walk(dir);
  return found;
}

/**
 * The workspace-package names a package imports, self excluded. Subpath entries
 * (`@bolusi/server/client`) collapse to their package name — the dist is the same build.
 * @param {string} dir
 * @param {string} selfName
 * @returns {string[]}
 */
function crossPackageImports(dir, selfName) {
  const names = new Set();
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import|require\()\s*['"](@bolusi\/[a-z0-9-]+)/g)) {
      if (match[1] !== selfName) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/**
 * Reads the repo into the plain model `checkTestScriptBuilds` consumes. All paths are
 * root-relative POSIX so the checker stays pure and fixture-testable.
 * @param {string} rootDir
 * @returns {any}
 */
export function readWorkspaceModel(rootDir) {
  /** @type {any[]} */
  const packages = [];
  /** @type {Record<string, string>} */
  const projectDirs = {};
  /** @type {string[]} */
  const unreadableProjects = [];
  /** @type {Record<string, any>} */
  const tsconfigs = {};

  const dirs = ['.'];
  for (const group of WORKSPACE_DIRS) {
    const groupPath = join(rootDir, group);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath)) {
      const full = join(groupPath, entry);
      if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) {
        dirs.push(`${group}/${entry}`);
      }
    }
  }

  for (const dir of dirs) {
    const abs = resolve(rootDir, dir);
    const pkgJson = readJsonc(join(abs, 'package.json'));
    packages.push({
      name: pkgJson.name ?? dir,
      dir,
      distOnly: isDistOnly(pkgJson),
      distImports: dir === '.' ? [] : crossPackageImports(abs, pkgJson.name ?? ''),
      scripts: pkgJson.scripts ?? {},
    });

    // The project name is scraped, not evaluated — this is a static check, and importing a
    // vitest config to ask would run arbitrary repo code. So the scrape's FAILURE has to be
    // loud: `name: N` (an ordinary extract-a-const refactor) or a template literal defeats the
    // regex, and a project missing from this map is a project whose scripts get checked against
    // nothing. Record the miss; `checkTestScriptBuilds` fails on it rather than assuming a
    // config it could not read has nothing to say.
    // The ROOT vitest.config.ts is the projects aggregator (`projects: [...]`), not a project:
    // it has no `name` and must not be read as one. Only per-package configs name a project.
    const vitestConfig = join(abs, 'vitest.config.ts');
    if (dir !== '.' && existsSync(vitestConfig)) {
      const name = /name:\s*'([^']+)'/.exec(readFileSync(vitestConfig, 'utf8'));
      if (name) projectDirs[name[1]] = dir;
      else unreadableProjects.push(`${dir}/vitest.config.ts`);
    }

    for (const entry of readdirSync(abs)) {
      if (!/^tsconfig.*\.json$/.test(entry)) continue;
      const key = dir === '.' ? entry : `${dir}/${entry}`;
      let parsed;
      try {
        parsed = readJsonc(join(abs, entry));
      } catch {
        continue;
      }
      const options = parsed.compilerOptions ?? {};
      tsconfigs[key] = {
        // A project emits a package's dist when it has an outDir and is not noEmit. Every
        // emitting project in this repo is a `tsconfig.build.json` shaped exactly so (§4).
        emits: options.noEmit !== true && typeof options.outDir === 'string',
        references: (parsed.references ?? []).map((ref) =>
          normalize(relative(rootDir, resolve(abs, ref.path))),
        ),
      };
    }
  }

  return { rootDir, packages, projectDirs, unreadableProjects, tsconfigs };
}

/**
 * @param {string} p
 * @returns {string}
 */
function normalize(p) {
  return p.split('\\').join('/');
}

/**
 * Resolves a `tsc -b` argument the way tsc does: a directory means its `tsconfig.json`.
 * @param {string} arg
 * @param {string} fromDir root-relative dir the script runs in
 * @param {any} tsconfigs
 * @returns {string}
 */
function resolveTsconfigArg(arg, fromDir, tsconfigs) {
  const base = normalize(join(fromDir, arg)).replace(/^\.\//, '');
  const candidate = base === '' ? 'tsconfig.json' : base;
  if (tsconfigs[candidate]) return candidate;
  const asDir = normalize(join(candidate, 'tsconfig.json')).replace(/^\.\//, '');
  return tsconfigs[asDir] ? asDir : candidate;
}

/**
 * The set of package dirs whose dist a command's `tsc -b` invocations actually produce,
 * following `references` transitively. Empty for a prefix that resolves a reference-less,
 * non-emitting project — task 24's trap, which is the case this function exists to expose.
 * @param {string} command
 * @param {string} pkgDir
 * @param {any} tsconfigs
 * @returns {Set<string>}
 */
export function builtPackageDirs(command, pkgDir, tsconfigs) {
  /** @type {Set<string>} */
  const built = new Set();
  const from = pkgDir === '.' ? '' : pkgDir;

  for (const segment of command.split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const tscIndex = tokens.findIndex((t) => t === 'tsc' || t.endsWith('/tsc'));
    if (tscIndex === -1 || !tokens.includes('-b')) continue;

    const args = tokens
      .slice(tscIndex + 1)
      .filter((t) => !t.startsWith('-') && t !== 'build' && t !== '-b');
    const roots = args.length > 0 ? args : ['.'];

    for (const arg of roots) {
      const start = resolveTsconfigArg(arg, from, tsconfigs);
      /** @type {string[]} */
      const queue = [start];
      const seen = new Set();
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        const config = tsconfigs[current];
        if (config === undefined) continue;
        if (config.emits) built.add(dirname(current) === '.' ? '.' : normalize(dirname(current)));
        queue.push(...config.references);
      }
    }
  }
  return built;
}

/**
 * The vitest projects a test command runs: the named `--project`s, or — for a root script that
 * names none — every project in the workspace.
 *
 * Unresolvable `--project` names come back as `unresolved`, NOT dropped. Dropping them is a
 * vacuous pass and this function shipped that bug: a name it could not map produced an empty
 * target list, hence an empty needed-set, hence "every cross-package import is built first" for
 * a script that builds nothing. The denominator cannot see it either — the script is still
 * COUNTED, just checked against nothing. That is §2.11's shape inside the file written to
 * prevent it, so the caller turns `unresolved` into a reported failure.
 * @param {string} command
 * @param {any} pkg
 * @param {any} model
 * @returns {{ dirs: string[], unresolved: string[] }}
 */
function targetDirs(command, pkg, model) {
  if (pkg.dir !== '.') return { dirs: [pkg.dir], unresolved: [] };
  const named = [...command.matchAll(/--project[= ]([\w-]+)/g)].map((m) => m[1]);
  if (named.length === 0) return { dirs: Object.values(model.projectDirs), unresolved: [] };

  /** @type {string[]} */
  const dirs = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const name of named) {
    const dir = model.projectDirs[name];
    if (dir === undefined) unresolved.push(name);
    else dirs.push(dir);
  }
  return { dirs, unresolved };
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function runsVitest(command) {
  return /\bvitest\b/.test(command);
}

/**
 * Checks every test script against 08 §5.6.
 *
 * Fails closed on its own blindness (§2.11): a model with no test scripts, or no dist-only
 * packages, is a checker that would agree with anything, so it reports failure instead.
 * @param {any} model
 * @returns {{ ok: boolean, violations: any[], checkedScripts: any[], message: string }}
 */
export function checkTestScriptBuilds(model) {
  const byName = new Map(model.packages.map((p) => [p.name, p]));
  const byDir = new Map(model.packages.map((p) => [p.dir, p]));
  const distOnly = new Set(model.packages.filter((p) => p.distOnly).map((p) => p.name));

  /** @type {any[]} */
  const violations = [];
  /** @type {any[]} */
  const checkedScripts = [];

  for (const pkg of model.packages) {
    for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
      if (typeof command !== 'string' || !runsVitest(command)) continue;

      const { dirs, unresolved } = targetDirs(command, pkg, model);

      const needed = new Set();
      for (const dir of dirs) {
        const target = byDir.get(dir);
        if (target === undefined) continue;
        for (const imported of target.distImports ?? []) {
          if (distOnly.has(imported)) needed.add(imported);
        }
      }

      const built = builtPackageDirs(command, pkg.dir, model.tsconfigs);
      const missing = [...needed]
        .filter((name) => {
          const dep = byName.get(name);
          return dep === undefined || !built.has(dep.dir);
        })
        .sort();

      checkedScripts.push({
        pkg: pkg.name,
        script,
        needed: [...needed].sort(),
        built: [...built].sort(),
        unresolved,
      });

      // Fail CLOSED per script: a `--project` this checker cannot map is a script it cannot
      // check, and "cannot check" must never render as "checked and fine".
      if (unresolved.length > 0) {
        violations.push({
          pkg: pkg.name,
          script,
          command,
          missing: [],
          unresolved,
          reason: `--project ${unresolved.join(', ')} does not match any vitest project name this check could read — it cannot tell what this script imports, so it refuses to pass it`,
        });
      }

      if (missing.length > 0) {
        violations.push({
          pkg: pkg.name,
          script,
          command,
          missing,
          unresolved: [],
          reason:
            built.size === 0
              ? 'no `tsc -b` reaches an emitting project — the prefix is absent, or it resolves a tsconfig with no references (task 24)'
              : 'the `tsc -b` prefix does not reach these packages',
        });
      }
    }
  }

  const unreadable = model.unreadableProjects ?? [];
  if (unreadable.length > 0) {
    return {
      ok: false,
      violations,
      checkedScripts,
      message:
        `could not read the vitest project name from: ${unreadable.join(', ')} — a project this ` +
        'check cannot name is a project whose scripts it would check against nothing. Give the ' +
        "config a literal `name: '...'`, or teach this script to read the form used.",
    };
  }
  if (distOnly.size === 0) {
    return {
      ok: false,
      violations,
      checkedScripts,
      message: 'found no dist-only workspace package — this check is looking at the wrong tree',
    };
  }
  if (checkedScripts.length === 0) {
    return {
      ok: false,
      violations,
      checkedScripts,
      message: 'found no test scripts — this check is looking at the wrong tree',
    };
  }
  if (violations.length > 0) {
    const detail = violations
      .map((v) => {
        const what = v.missing.length > 0 ? `needs ${v.missing.join(', ')}` : 'unresolvable target';
        return `  ${v.pkg} · "${v.script}": ${what} — ${v.reason}\n    ${v.command}`;
      })
      .join('\n');
    return {
      ok: false,
      violations,
      checkedScripts,
      message: `${violations.length} test script(s) violate 08 §5.6 (import a dist-only workspace package without building it, or cannot be checked):\n${detail}`,
    };
  }
  return {
    ok: true,
    violations,
    checkedScripts,
    message: `${checkedScripts.length} test scripts checked, ${distOnly.size} dist-only packages — every cross-package import is built first (08 §5.6)`,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkTestScriptBuilds(readWorkspaceModel(root));
  console[result.ok ? 'log' : 'error'](`check-test-script-builds: ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
