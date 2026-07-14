// Unit tests for the CI stage-1 lockfile checks (08 §2.1.6, §2.6; task 01 acceptance).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { checkSingleZod } from '../../../scripts/check-single-zod.mjs';
// @ts-expect-error — plain .mjs script without type declarations (CI entry point)
import { checkForbiddenPackages } from '../../../scripts/check-forbidden-packages.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const realLockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');

test('single-zod check fails on a fixture lockfile containing zod v3 and v4', () => {
  const fixture = [
    'packages:',
    '  zod@3.23.8:',
    '    resolution: { integrity: sha512-fake3 }',
    '  zod@4.4.3:',
    '    resolution: { integrity: sha512-fake4 }',
    '  @hono/zod-validator@0.8.0(zod@4.4.3):',
    '    resolution: { integrity: sha512-fake5 }',
  ].join('\n');
  const result = checkSingleZod(fixture);
  expect(result.ok).toBe(false);
  expect(result.versions).toEqual(['3.23.8', '4.4.3']);
});

test('single-zod check fails on a lockfile with no zod at all', () => {
  expect(checkSingleZod('packages:\n  hono@4.12.30:\n').ok).toBe(false);
});

test('single-zod check passes on the real committed lockfile', () => {
  const result = checkSingleZod(realLockfile);
  expect(result.ok).toBe(true);
  expect(result.versions).toEqual(['4.4.3']);
});

test('forbidden-packages check fails on a fixture lockfile containing @hono/node-ws', () => {
  const fixture = 'packages:\n  @hono/node-ws@1.2.0:\n    resolution: { integrity: sha512-x }\n';
  const result = checkForbiddenPackages(fixture);
  expect(result.ok).toBe(false);
  expect(result.found).toEqual(['@hono/node-ws']);
});

test('forbidden-packages check passes on the real committed lockfile', () => {
  expect(checkForbiddenPackages(realLockfile)).toEqual({ ok: true, found: [] });
});
