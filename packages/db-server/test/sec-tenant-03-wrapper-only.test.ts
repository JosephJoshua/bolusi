// SEC-TENANT-03 — wrapper-only query path (security-guide §8.2).
//
// Two legs, both required by the id:
//   (1) a lint fixture importing the raw handle / `pg` outside packages/db-server fails lint;
//   (2) the repo-wide grep for `set_config(.*false)` / `SET app.tenant_id` is clean.
//
// This file is on `check-tenant-context.mjs`'s EXEMPT_PATHS list because the negative tests
// below must contain the very strings the scanner hunts for. The exemption is why those
// negative tests exist: they prove the scanner still fires on the pattern.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

// Namespace import kept on ONE line on purpose: the directive must sit directly above the
// module specifier, and prettier wraps a long named-import list onto its own lines.
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import * as tenantContext from '../../../scripts/check-tenant-context.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

interface Finding {
  path: string;
  line: number;
  match: string;
  rule: string;
}

const { collectScannableFiles, EXEMPT_PATHS, findForbiddenTenantContext } = tenantContext as {
  collectScannableFiles: (repoRoot: string) => { path: string; text: string }[];
  EXEMPT_PATHS: Set<string>;
  findForbiddenTenantContext: (files: { path: string; text: string }[]) => Finding[];
};

const scanFiles = findForbiddenTenantContext;

async function lintFixture(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintText(code, { filePath: resolve(REPO_ROOT, filePath) });
  return results.flatMap((r) => r.messages.map((m) => `${m.ruleId ?? 'unknown'}: ${m.message}`));
}

// Fixtures are linted as virtual files under packages/harness (a real workspace OUTSIDE
// packages/db-server). apps/server/src is deliberately avoided: the `bolusi/server-typed`
// config block turns on typescript-eslint's projectService there, which rejects any path that
// is not a real file in the tsconfig — the boundary rule under test would never get to run.
const OUTSIDE_DB_SERVER = 'packages/harness/src';

test('SEC-TENANT-03 importing the pg driver outside packages/db-server fails lint', async () => {
  const messages = await lintFixture(
    `import pg from 'pg';\nexport const pool = new pg.Pool();\n`,
    `${OUTSIDE_DB_SERVER}/__fixture-raw-pg.ts`,
  );

  expect(messages.join('\n')).toMatch(/bolusi\/boundaries/);
  expect(messages.join('\n')).toMatch(/Only packages\/db-server may import the DB driver 'pg'/);
});

test('SEC-TENANT-03 deep-importing the raw db handle outside packages/db-server fails lint', async () => {
  // The raw-handle escape hatch: src/db.ts is not re-exported from the package entry, so the
  // only way to reach it is a deep import. That must not lint.
  const messages = await lintFixture(
    `import { getDb } from '@bolusi/db-server/dist/db.js';\nexport const db = getDb();\n`,
    `${OUTSIDE_DB_SERVER}/__fixture-raw-handle.ts`,
  );

  expect(messages.join('\n')).toMatch(/bolusi\/boundaries/);
  expect(messages.join('\n')).toMatch(/deep imports into @bolusi\/db-server are forbidden/);
});

test('SEC-TENANT-03 the sanctioned forTenant import passes lint', async () => {
  // The negative control: if the boundary rule rejected everything, the tests above would pass
  // for the wrong reason.
  const messages = await lintFixture(
    `import { forTenant } from '@bolusi/db-server';\nexport const f = forTenant;\n`,
    `${OUTSIDE_DB_SERVER}/__fixture-for-tenant.ts`,
  );

  expect(messages.join('\n')).not.toMatch(/bolusi\/boundaries/);
});

test('SEC-TENANT-03 pg is importable inside packages/db-server', async () => {
  // The allowlist half of the rule: db-server is the driver's sanctioned home, so the lock is
  // a boundary rather than a ban.
  const messages = await lintFixture(
    `import pg from 'pg';\nexport const pool = new pg.Pool();\n`,
    'packages/db-server/src/__fixture-pool.ts',
  );

  expect(messages.join('\n')).not.toMatch(/bolusi\/boundaries/);
});

test('SEC-TENANT-03 the repo contains no session-level tenant context', async () => {
  const files = collectScannableFiles(REPO_ROOT);

  // Guard: a scan that found no files would pass silently. Anchored on a long-committed file —
  // the walk covers TRACKED files only (by design, so an untracked decoy cannot smuggle the
  // pattern past CI), which means a file is in scope from the commit that adds it onward.
  expect(files.length).toBeGreaterThan(10);
  expect(files.some((f) => f.path === 'scripts/check-single-zod.mjs')).toBe(true);

  expect(scanFiles(files)).toEqual([]);
});

test('SEC-TENANT-03 the grep fires on set_config with is_local = false', () => {
  const findings = scanFiles([
    {
      path: 'apps/server/src/leaky.ts',
      text: `await sql\`SELECT set_config('app.tenant_id', \${id}, false)\`.execute(db);`,
    },
  ]);

  expect(findings).toHaveLength(1);
  expect(findings[0]?.rule).toBe('set_config with is_local = false');
});

test('SEC-TENANT-03 the grep fires on a session-level SET app.tenant_id', () => {
  const findings = scanFiles([
    {
      path: 'apps/server/src/leaky.ts',
      text: `await sql\`SET app.tenant_id = '...'\`.execute(db);`,
    },
    { path: 'apps/server/src/leaky2.sql', text: `SET SESSION app.tenant_id = 'x';` },
  ]);

  expect(findings.map((f) => f.rule)).toEqual([
    'session-level SET app.tenant_id',
    'session-level SET app.tenant_id',
  ]);
});

test('SEC-TENANT-03 the grep accepts the sanctioned transaction-local form', () => {
  const findings = scanFiles([
    {
      path: 'packages/db-server/src/for-tenant.ts',
      text: `await sql\`SELECT set_config('app.tenant_id', \${validTenantId}, true)\`.execute(trx);`,
    },
  ]);

  expect(findings).toEqual([]);
});

test('SEC-TENANT-03 the grep exemption list stays minimal', () => {
  // Every exemption is a hole. Pin the list so widening it is a reviewed decision.
  expect([...EXEMPT_PATHS].sort()).toEqual([
    'packages/db-server/test/sec-tenant-03-wrapper-only.test.ts',
    'scripts/check-tenant-context.mjs',
  ]);
});
