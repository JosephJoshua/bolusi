// The pipeline is a LIBRARY layer: importable and runnable in-process with zero Hono/HTTP, so the
// task-26 chaos harness can drive CHAOS-04/05/06 without sockets (task 07 acceptance). Enforced by
// the scoped `no-restricted-imports` rule on apps/server/src/oplog/** (tooling/eslint
// bolusi/oplog-no-http).
//
// This is the fixture that proves the rule FIRES (testing-guide T-11 / CLAUDE.md §2.11 — a guard
// nobody has watched go red is not load-bearing). Both halves matter: the rule must reject Hono
// inside src/oplog AND must not be a blanket ban that would make any green meaningless.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
const OPLOG_SRC = resolve(REPO_ROOT, 'apps/server/src/oplog');

async function lintFixture(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintText(code, { filePath: resolve(REPO_ROOT, filePath) });
  return results.flatMap((r) => r.messages.map((m) => `${m.ruleId ?? 'unknown'}: ${m.message}`));
}

// Virtual *.test.ts paths: `bolusi/server-typed` enables typescript-eslint's projectService for
// apps/server/src/**/*.ts but IGNORES *.test.ts, so these fixtures get the syntactic rules without
// a program lookup that would reject a path with no file behind it.
const IN_OPLOG = 'apps/server/src/oplog/__fixture-http__.test.ts';
const OUTSIDE_OPLOG = 'apps/server/src/routes/__fixture-http__.test.ts';

describe('the scoped no-http rule fires inside src/oplog', () => {
  test('importing hono inside src/oplog fails lint', async () => {
    const messages = await lintFixture(
      `import { Hono } from 'hono';\nexport const app = new Hono();\n`,
      IN_OPLOG,
    );

    expect(messages.join('\n')).toMatch(/no-restricted-imports/);
    expect(messages.join('\n')).toMatch(/HTTP-free/);
  });

  test('importing a @hono/* subpackage inside src/oplog fails lint', async () => {
    const messages = await lintFixture(
      `import { serve } from '@hono/node-server';\nexport const s = serve;\n`,
      IN_OPLOG,
    );

    expect(messages.join('\n')).toMatch(/no-restricted-imports/);
  });

  test('importing node:http inside src/oplog fails lint', async () => {
    const messages = await lintFixture(
      `import { createServer } from 'node:http';\nexport const s = createServer;\n`,
      IN_OPLOG,
    );

    expect(messages.join('\n')).toMatch(/no-restricted-imports/);
  });

  test('the sanctioned imports the pipeline actually uses pass lint (non-vacuous control)', async () => {
    // If the rule banned everything, the three tests above would pass for the wrong reason.
    const messages = await lintFixture(
      `import { verifyOp } from '@bolusi/core';\nimport type { ForTenant } from '@bolusi/db-server';\nexport const v = verifyOp;\nexport type F = ForTenant;\n`,
      IN_OPLOG,
    );

    expect(messages.join('\n')).not.toMatch(/no-restricted-imports/);
  });

  test('the rule is SCOPED: hono outside src/oplog still passes lint', async () => {
    // The route layer (task 16) is where Hono belongs. A rule that fired repo-wide would be a
    // different (and wrong) rule.
    const messages = await lintFixture(
      `import { Hono } from 'hono';\nexport const app = new Hono();\n`,
      OUTSIDE_OPLOG,
    );

    expect(messages.join('\n')).not.toMatch(/no-restricted-imports/);
  });
});

describe('the shipped pipeline source is HTTP-free', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  test('no file under src/oplog imports hono, @hono/*, ws, or node:http*', () => {
    const files = walk(OPLOG_SRC).filter((f) => f.endsWith('.ts'));

    // Denominator (T-14): a sweep over an empty/mis-globbed collection passes silently. The
    // pipeline is ~10 modules; a floor of 8 fails loudly if the walk ever starves.
    expect(files.length).toBeGreaterThanOrEqual(8);

    const offenders = files.filter((file) =>
      /from\s+'(hono|@hono\/[^']+|ws|node:http2?|node:https)'/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  test('the pipeline entry imports cleanly with no HTTP server in the module graph', async () => {
    // The in-process drivability claim, exercised rather than asserted: importing the pipeline must
    // not require a transport. If a Hono/ws edge crept in, this import pulls it into the graph.
    const mod = await import('../../../src/oplog/index.js');

    expect(typeof mod.processPushBatch).toBe('function');
    expect(typeof mod.appendSystemOp).toBe('function');
  });
});
