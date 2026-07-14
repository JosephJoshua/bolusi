// Single-zod lockfile check (08-stack-and-repo §2.1.6; security-guide §11).
// Fails if pnpm-lock.yaml resolves more than one zod version (or none at all —
// zod is load-bearing, its absence means the lockfile under test is not the real one).
// CI stage 1 runs this right after `pnpm install --frozen-lockfile`.
import { readFileSync } from 'node:fs';

/**
 * Extract the set of distinct resolved `zod` versions from pnpm lockfile text.
 * Matches both package keys (`zod@4.4.3:`) and peer suffixes (`(zod@4.4.3)`).
 * The lookbehind keeps scoped/prefixed names like `@hono/zod-validator@…` from matching.
 * @param {string} lockfileText
 * @returns {Set<string>}
 */
export function findZodVersions(lockfileText) {
  const versions = new Set();
  const re = /(?<![\w.-])zod@(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;
  for (const match of lockfileText.matchAll(re)) {
    versions.add(match[1]);
  }
  return versions;
}

/**
 * @param {string} lockfileText
 * @returns {{ ok: boolean, versions: string[], message: string }}
 */
export function checkSingleZod(lockfileText) {
  const versions = [...findZodVersions(lockfileText)].sort();
  if (versions.length === 1) {
    return { ok: true, versions, message: `single zod version: ${versions[0]}` };
  }
  if (versions.length === 0) {
    return { ok: false, versions, message: 'no zod version found in lockfile — check the input' };
  }
  return {
    ok: false,
    versions,
    message: `multiple zod versions in lockfile: ${versions.join(', ')} — one zod only (08-stack-and-repo §2.1.6)`,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const lockfilePath = process.argv[2] ?? 'pnpm-lock.yaml';
  const result = checkSingleZod(readFileSync(lockfilePath, 'utf8'));
  console[result.ok ? 'log' : 'error'](`check-single-zod: ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
