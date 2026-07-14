// Forbidden-package lockfile check (08-stack-and-repo §2.6).
// Fails if any package rejected by the spec appears anywhere in pnpm-lock.yaml.
import { readFileSync } from 'node:fs';

export const FORBIDDEN = [
  '@hono/node-ws', // deprecated; upgradeWebSocket comes from @hono/node-server 2.x
  'expo-background-fetch', // deprecated; use expo-background-task
  'expo-sqlite', // designated swap target — never installed alongside op-sqlite in v0
  'kysely-expo', // tracks expo-sqlite in SDK lockstep; we own the op-sqlite dialect shim
];

/**
 * @param {string} lockfileText
 * @returns {{ ok: boolean, found: string[] }}
 */
export function checkForbiddenPackages(lockfileText) {
  const found = FORBIDDEN.filter((name) =>
    new RegExp(`(?<![\\w.-])${name.replace(/[/@-]/g, '\\$&')}@\\d`).test(lockfileText),
  );
  return { ok: found.length === 0, found };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const lockfilePath = process.argv[2] ?? 'pnpm-lock.yaml';
  const result = checkForbiddenPackages(readFileSync(lockfilePath, 'utf8'));
  if (!result.ok) {
    console.error(
      `check-forbidden-packages: forbidden packages in lockfile: ${result.found.join(', ')} (08-stack-and-repo §2.6)`,
    );
    process.exit(1);
  }
  console.log('check-forbidden-packages: none of the §2.6 forbidden packages are in the lockfile');
}
