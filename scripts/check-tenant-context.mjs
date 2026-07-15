// Tenant-context grep (security-guide §8.1/§8.2 SEC-TENANT-03; 10-db-schema §6.1).
//
// Two forbidden ways to set the tenant GUC, both of which leak tenant context across requests
// on a pooled connection:
//   1. `set_config('app.tenant_id', x, false)` — is_local = false sets it for the whole SESSION.
//   2. `SET app.tenant_id = ...`               — session-level SET, same problem.
// The only sanctioned form is `set_config('app.tenant_id', $1, true)` inside an explicit
// transaction, issued by forTenant() in @bolusi/db-server.
//
// This is a repo-wide grep, not a lint rule, on purpose: it must catch the pattern in raw SQL
// strings, migrations, shell scripts and docs-as-code — places ESLint never parses.
// CI runs it alongside the other stage-1/stage-2 checks.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Files exempt from the scan, exactly. Each entry is a file whose JOB is to contain the
 * forbidden pattern (a detector, or a test proving the detector fires). Keep this list tiny:
 * every entry is a hole, so an addition needs a reason a reviewer can check.
 */
export const EXEMPT_PATHS = new Set([
  'scripts/check-tenant-context.mjs',
  'packages/db-server/test/sec-tenant-03-wrapper-only.test.ts',
]);

/** `set_config(... 'app.tenant_id' ..., false)` — is_local = false. */
const SESSION_SET_CONFIG = /set_config\s*\([^)]*app\.tenant_id[^)]*,\s*false\s*\)/gi;

/** A bare `SET app.tenant_id` / `SET LOCAL app.tenant_id` statement. */
const BARE_SET = /\bSET\s+(?:LOCAL\s+|SESSION\s+)?app\.tenant_id\b/gi;

/**
 * Scans file contents for forbidden tenant-context statements.
 * @param {{ path: string, text: string }[]} files
 * @returns {{ path: string, line: number, match: string, rule: string }[]}
 */
export function findForbiddenTenantContext(files) {
  const findings = [];

  for (const { path, text } of files) {
    if (EXEMPT_PATHS.has(path)) continue;

    for (const [rule, pattern] of [
      ['set_config with is_local = false', SESSION_SET_CONFIG],
      ['session-level SET app.tenant_id', BARE_SET],
    ]) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push({ path, line, match: match[0], rule });
      }
    }
  }

  return findings;
}

/**
 * Tracked files only — `git ls-files` keeps the walk inside the git tree.
 * @param {string} repoRoot
 * @returns {{ path: string, text: string }[]}
 */
export function collectScannableFiles(repoRoot) {
  const result = spawnSync(
    'git',
    ['ls-files', '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.sql', '*.sh'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return (
    result.stdout
      .split('\n')
      .filter(Boolean)
      // `git ls-files` lists tracked paths, including ones deleted in the working tree but not
      // yet staged. Skip those rather than crash — the scan is about what the tree contains now.
      .filter((path) => existsSync(`${repoRoot}/${path}`))
      .map((path) => ({ path, text: readFileSync(`${repoRoot}/${path}`, 'utf8') }))
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const findings = findForbiddenTenantContext(collectScannableFiles(repoRoot));

  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`check-tenant-context: ${f.path}:${f.line} — ${f.rule}: ${f.match}`);
    }
    console.error(
      "Tenant context is transaction-local ONLY: set_config('app.tenant_id', $1, true) via forTenant() (10-db-schema §6.1).",
    );
    process.exit(1);
  }

  console.log('check-tenant-context: no session-level tenant context found');
}
