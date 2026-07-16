// Unit tests for the 08 §5.6 build-prefix gate (task 55).
//
// §5.6 is normative: "any test script that imports a built cross-package entry MUST prefix
// `tsc -b &&`". It has been violated FOUR times by four agents — task 32 (`test:server`),
// task 24 (the mobile lane), task 55 (`test:rls`, and `@bolusi/db-client`'s bare `vitest run`,
// found by that task's class sweep). A rule broken four times is not enforced, it is
// remembered badly, so it is now checked by a machine.
//
// WHAT THESE TESTS PIN, AND WHY EACH ONE EXISTS
// ---------------------------------------------
// The gate's whole value is that it models `tsc -b` RESOLUTION, not the presence of the
// characters "tsc -b" in a string. Task 24 proved the difference is load-bearing: a bare
// `tsc -b` in apps/mobile resolved apps/mobile/tsconfig.json, which has no `references` and
// cannot get any (§5.6 forbids `composite` there), so it built NOTHING and the lane stayed a
// fake green with the required prefix present. A gate that grepped for `tsc -b` would have
// certified exactly that bug. `builds nothing because the tsconfig it resolves has no
// references` below is that case, and it is the reason the checker resolves the graph.
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { checkTestScriptBuilds } from '../../../scripts/check-test-script-builds.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { readWorkspaceModel } from '../../../scripts/check-test-script-builds.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

interface WorkspacePackage {
  name: string;
  dir: string;
  distOnly: boolean;
  distImports: string[];
  scripts: Record<string, string>;
}

interface WorkspaceModel {
  rootDir: string;
  packages: WorkspacePackage[];
  projectDirs: Record<string, string>;
  unreadableProjects?: string[];
  tsconfigs: Record<string, { emits: boolean; references: string[] }>;
}

interface CheckedScript {
  pkg: string;
  script: string;
  needed: string[];
  built: string[];
  unresolved: string[];
}

interface Violation {
  pkg: string;
  script: string;
  command: string;
  missing: string[];
  unresolved: string[];
  reason: string;
}

interface CheckResult {
  ok: boolean;
  violations: Violation[];
  checkedScripts: CheckedScript[];
  message: string;
}

const check = checkTestScriptBuilds as (model: WorkspaceModel) => CheckResult;
const readModel = readWorkspaceModel as (root: string) => WorkspaceModel;

/** The solution file every compliant prefix reaches: root -> lib's emitting build config. */
const SOLUTION_TSCONFIGS: WorkspaceModel['tsconfigs'] = {
  'tsconfig.json': { emits: false, references: ['packages/lib/tsconfig.build.json'] },
  'packages/lib/tsconfig.build.json': { emits: true, references: [] },
  'apps/app/tsconfig.json': { emits: false, references: [] },
};

/** A minimal two-package workspace: `app` runs tests and imports dist-only `lib`. */
function fixture(options: {
  scripts: Record<string, string>;
  distImports?: string[];
  libDistOnly?: boolean;
  rootScripts?: Record<string, string>;
}): WorkspaceModel {
  const packages: WorkspacePackage[] = [
    {
      name: '@x/app',
      dir: 'apps/app',
      distOnly: false,
      distImports: options.distImports ?? ['@x/lib'],
      scripts: options.scripts,
    },
    {
      name: '@x/lib',
      dir: 'packages/lib',
      distOnly: options.libDistOnly ?? true,
      distImports: [],
      scripts: {},
    },
  ];
  if (options.rootScripts) {
    packages.push({
      name: 'root',
      dir: '.',
      distOnly: false,
      distImports: [],
      scripts: options.rootScripts,
    });
  }
  return {
    rootDir: '/repo',
    packages,
    projectDirs: { app: 'apps/app', lib: 'packages/lib' },
    tsconfigs: SOLUTION_TSCONFIGS,
  };
}

test('flags a test script with no build prefix that imports a dist-only package', () => {
  const result = check(fixture({ scripts: { test: 'vitest run' } }));
  expect(result.ok).toBe(false);
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]).toMatchObject({
    pkg: '@x/app',
    script: 'test',
    missing: ['@x/lib'],
  });
});

// Task 24's trap, and the reason this gate resolves references instead of grepping.
test('flags a `tsc -b` that builds nothing because the tsconfig it resolves has no references', () => {
  const result = check(fixture({ scripts: { test: 'tsc -b && vitest run' } }));
  expect(result.ok).toBe(false);
  expect(result.violations[0]).toMatchObject({
    pkg: '@x/app',
    script: 'test',
    missing: ['@x/lib'],
  });
});

test('passes a script whose `tsc -b ../..` reaches the dist package through the solution file', () => {
  const result = check(fixture({ scripts: { test: 'tsc -b ../.. && vitest run' } }));
  expect(result.ok).toBe(true);
  expect(result.violations).toEqual([]);
});

test('passes a script that names the emitting tsconfig directly', () => {
  const result = check(
    fixture({ scripts: { test: 'tsc -b ../../packages/lib/tsconfig.build.json && vitest run' } }),
  );
  expect(result.ok).toBe(true);
});

test('ignores test scripts that import no dist-only workspace package', () => {
  const result = check(fixture({ scripts: { test: 'vitest run' }, distImports: [] }));
  expect(result.ok).toBe(true);
});

// A root script names its projects; the gate must follow `--project` to the right package
// rather than assume the script's own directory (that is how `test:rls` hid).
test('resolves a root script `--project` to the target package and flags its missing build', () => {
  const result = check(
    fixture({
      scripts: {},
      rootScripts: { 'test:x': 'node scripts/lane.mjs -- vitest run --project app' },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.violations[0]).toMatchObject({
    pkg: 'root',
    script: 'test:x',
    missing: ['@x/lib'],
  });
});

// A guard must assert its own coverage (CLAUDE.md §2.11): one that silently checks nothing
// is worse than none, because it converts an unknown risk into a false assurance.
test('fails when it finds no test scripts at all, rather than reporting a vacuous green', () => {
  const result = check(fixture({ scripts: { build: 'tsc -b' } }));
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/no test scripts/i);
});

test('fails when the workspace exposes no dist-only package, rather than checking nothing', () => {
  const result = check(fixture({ scripts: { test: 'vitest run' }, libDistOnly: false }));
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/no dist-only/i);
});

// Review-55's finding, and the bug this file's own author shipped: the two checks above fail
// closed on GLOBAL blindness (zero scripts / zero dist packages) but said nothing about
// PER-SCRIPT blindness. A `--project` name that resolved to nothing was silently dropped,
// yielding an empty needed-set — so the script was still COUNTED in the denominator while being
// checked against nothing, and the gate printed a confident green. Refusing to pass what it
// cannot check is the whole difference between a guard and a decoration.
test('refuses a script whose `--project` names a project it cannot resolve', () => {
  const result = check(
    fixture({
      scripts: {},
      rootScripts: { 'test:server': 'vitest run --project unmappable' },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.violations[0]).toMatchObject({ pkg: 'root', script: 'test:server' });
  expect(result.violations[0]?.unresolved).toEqual(['unmappable']);
  expect(result.violations[0]?.reason).toMatch(
    /cannot tell what this script imports|does not match/i,
  );
});

// The upstream half of the same blindness: the project name is scraped from vitest.config.ts,
// so `const N = 'server'; … name: N` (an ordinary refactor) defeats the regex. A project the
// checker cannot name is a project whose scripts it would check against nothing.
test('refuses the whole run when a vitest config project name cannot be read', () => {
  const model = fixture({ scripts: { test: 'tsc -b ../.. && vitest run' } });
  model.unreadableProjects = ['apps/server/vitest.config.ts'];
  const result = check(model);
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/could not read the vitest project name/i);
});

// The real repo. This is the row that goes red when someone drops a build prefix.
test('passes on the real committed workspace', () => {
  const result = check(readModel(REPO_ROOT));
  expect(result.violations).toEqual([]);
  expect(result.ok).toBe(true);
});

// ...and it is really looking at this repo, not at an empty model that agrees with everything.
test('the real-workspace check covers the known test scripts and dist-only packages', () => {
  const model = readModel(REPO_ROOT);
  const result = check(model);

  // The lanes §5.6 is about. `test:rls` is task 55's subject; db-client's is the fourth
  // violation its sweep found.
  const checked = result.checkedScripts.map((s) => `${s.pkg}:${s.script}`);
  expect(checked).toContain('bolusi:test:rls');
  expect(checked).toContain('bolusi:test');
  expect(checked).toContain('@bolusi/db-client:test');
  expect(checked).toContain('@bolusi/mobile:test');

  // `test:rls` must be seen to NEED a real build, or its row proves nothing.
  const rls = result.checkedScripts.find((s) => s.script === 'test:rls');
  expect(rls?.needed).toContain('@bolusi/core');

  expect(model.packages.filter((p) => p.distOnly).length).toBeGreaterThanOrEqual(8);

  // The class version of the line above (T-12). Pinning only `test:rls`'s needed-set catches
  // only `test:rls` going blind; every OTHER script could quietly resolve to nothing and the
  // suite would still be green. No script may be counted while checked against nothing.
  for (const s of result.checkedScripts) {
    expect(s.unresolved, `${s.pkg}:${s.script} has an unresolvable --project`).toEqual([]);
  }

  // Every lane known to import a dist-only package must be SEEN to need one. This is the
  // tripwire that goes red if project-name resolution silently breaks for any of them.
  const mustNeedSomething = [
    'bolusi:test',
    'bolusi:test:rls',
    'bolusi:test:server',
    'bolusi:test:appliers',
    'bolusi:test:ed25519-interop',
    '@bolusi/mobile:test',
    '@bolusi/core:test',
    '@bolusi/db-client:test',
  ];
  for (const key of mustNeedSomething) {
    const row = result.checkedScripts.find((s) => `${s.pkg}:${s.script}` === key);
    expect(row, `${key} is missing from the checked set`).toBeDefined();
    expect(row?.needed.length, `${key} was checked against an empty needed-set`).toBeGreaterThan(0);
  }
});

// The source of the per-script blindness: a project whose name the scraper cannot read never
// enters `projectDirs`. Assert the map accounts for every vitest config on disk — the class
// check, rather than one assertion per project that someone must remember to add.
test('every vitest.config.ts in the repo resolves to a named project', () => {
  const model = readModel(REPO_ROOT);
  expect(model.unreadableProjects ?? []).toEqual([]);

  const configs = globSync('{apps,packages,tooling}/*/vitest.config.ts', { cwd: REPO_ROOT });
  expect(configs.length).toBeGreaterThanOrEqual(12);
  expect(Object.keys(model.projectDirs)).toHaveLength(configs.length);
});

// The gate reads package.json from disk; pin that `test:rls` carries the prefix, so deleting
// it is a red test and not merely a red gate.
test('the real `test:rls` script builds before it runs the postgres lane (08 §5.6)', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts['test:rls']).toMatch(/^tsc -b &&/);
});
