// better-sqlite3 is test-only (08 §2.5): it backs the harness's simulated devices and
// db-client's CI conformance adapter, and must never appear in a shipping dependency list.
//
// The lint rule (bolusi/boundaries) catches an *import* in shipping source; this catches
// the other half — a `dependencies` entry that would drag the driver into the device
// bundle even with no import site. Both halves are needed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** Workspaces whose `dependencies` ship to a device or a server. */
const SHIPPING_WORKSPACES = [
  'apps/mobile',
  'apps/server',
  'packages/core',
  'packages/db-client',
  'packages/db-server',
  'packages/i18n',
  'packages/modules',
  'packages/schemas',
  'packages/ui',
];

/** Test-only packages that must never be a runtime dependency of shipping code. */
const TEST_ONLY_PACKAGES = ['better-sqlite3', '@types/better-sqlite3', '@electric-sql/pglite'];

function readPackageJson(workspace: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, workspace, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
}

test.each(SHIPPING_WORKSPACES)('%s declares no test-only driver in dependencies', (workspace) => {
  const dependencies = Object.keys(readPackageJson(workspace).dependencies ?? {});
  expect(dependencies.filter((name) => TEST_ONLY_PACKAGES.includes(name))).toEqual([]);
});

test('db-client keeps better-sqlite3 as a devDependency only', () => {
  // Explicit rather than implied by the sweep above: db-client is the package where the
  // temptation is real, since its CI adapter genuinely needs the driver.
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages/db-client/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  expect(Object.keys(pkg.dependencies ?? {})).not.toContain('better-sqlite3');
  expect(Object.keys(pkg.devDependencies ?? {})).toContain('better-sqlite3');
  // op-sqlite is the opposite case: it is db-client's one shipping driver (08 §3.2).
  expect(Object.keys(pkg.dependencies ?? {})).toContain('@op-engineering/op-sqlite');
});

test('@bolusi/test-support is never a runtime dependency of shipping code', () => {
  // 08 §3.3 hard rule 6: test-support and harness appear only in test files.
  for (const workspace of SHIPPING_WORKSPACES) {
    const dependencies = Object.keys(readPackageJson(workspace).dependencies ?? {});
    expect(dependencies).not.toContain('@bolusi/test-support');
    expect(dependencies).not.toContain('@bolusi/harness');
  }
});
