// Repo secrets scan (security-guide §10) — the sweep's "no secrets in the repo, ever" leg.
//
// Three checks, and the second is the one the pre-commit hook cannot give you:
//   1. gitleaks over the WORKING TREE — what is on disk right now.
//   2. gitleaks over the FULL GIT HISTORY — a secret committed and then deleted is still in the
//      pack files and still leaked. `gitleaks git` walks the log; the pre-commit hook only ever
//      sees the staged diff.
//   3. `.env` is gitignored, absent from the working tree, and absent from every commit; the
//      committed `.env.example` is a NAME LIST — every assignment has an empty right-hand side, so
//      a real value cannot ride in on the "authoritative list of required env vars".
//
// gitleaks being absent is a FAILURE, never a skip: a scanner that quietly does not run is the
// green-for-nothing shape CLAUDE.md §2.11 exists to stop. (SEC-SECRET-02's fixture test in
// @bolusi/test-support already proves this same binary catches a planted credential.)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * A var name that could plausibly carry a credential. `URL` is included because a Postgres DSN is
 * the most likely real secret to be pasted into an example file, and it is spelled `DATABASE_URL`.
 */
const SECRET_BEARING_NAME =
  /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|URL|AUTH|SALT|SIGNING)/i;

/**
 * Parse a `.env.example`. Returns the declared names, the assignments that carry a value at all,
 * and — the load-bearing subset — the assignments that carry a value on a SECRET-BEARING name.
 *
 * WHY THE SPLIT, STATED RATHER THAN SLIPPED IN. security-guide §10 and 08 §8 say the file is a
 * NAME LIST ("no values"). Read to the letter, the committed `PORT=3000` violates it. Failing the
 * release gate on a port number is how a gate gets deleted (the guide makes exactly this argument
 * about over-broad rules), so the FAILURE is scoped to values on secret-bearing names — which is
 * the asset — while `withValues` reports every non-empty assignment in the sweep output so the
 * literal-spec discrepancy stays visible instead of vanishing. Whether `PORT=3000` should be
 * removed or the spec relaxed is a spec question, filed as its own task, not decided here.
 */
export function parseEnvExample(text) {
  const names = [];
  const withValues = [];
  const secretsWithValues = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assignment === null) {
      secretsWithValues.push(`${line} (not a NAME= declaration)`);
      continue;
    }
    names.push(assignment[1]);
    if (assignment[2].trim() === '') continue;
    withValues.push(line);
    if (SECRET_BEARING_NAME.test(assignment[1])) secretsWithValues.push(line);
  }
  return { names, withValues, secretsWithValues };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

export function scanSecrets({ repoRoot = '.', envExamplePath = 'apps/server/.env.example' } = {}) {
  const failures = [];
  const notes = [];
  const checked = { gitleaksVersion: null, envNames: 0, historyHits: null };

  const version = run('gitleaks', ['version']);
  if (version.error) {
    failures.push(
      `gitleaks is not runnable (${version.error.message}) — the secret scan is MANDATORY (security-guide §10); install https://github.com/gitleaks/gitleaks`,
    );
    return { ok: false, failures, checked };
  }
  checked.gitleaksVersion = version.stdout.trim();

  // 1 — working tree.
  const tree = run('gitleaks', ['dir', repoRoot, '--no-banner', '--exit-code', '1'], {
    cwd: repoRoot,
  });
  if (tree.status !== 0) {
    failures.push(`gitleaks found secrets in the WORKING TREE:\n${tree.stdout}${tree.stderr}`);
  }

  // 2 — full history.
  const history = run('gitleaks', ['git', repoRoot, '--no-banner', '--exit-code', '1'], {
    cwd: repoRoot,
  });
  checked.historyHits = history.status;
  if (history.status !== 0) {
    failures.push(`gitleaks found secrets in GIT HISTORY:\n${history.stdout}${history.stderr}`);
  }

  // 3 — .env discipline.
  const ignored = run('git', ['check-ignore', '-q', '.env'], { cwd: repoRoot });
  if (ignored.status !== 0) {
    failures.push('.env is NOT gitignored (security-guide §10)');
  }
  if (existsSync(`${repoRoot}/.env`)) {
    failures.push(
      '.env exists in the working tree of a repo being scanned — it must never be here',
    );
  }
  const inHistory = run('git', ['log', '--all', '--pretty=format:%H', '--', '.env'], {
    cwd: repoRoot,
  });
  if (inHistory.stdout.trim() !== '') {
    failures.push(
      `.env appears in git history (commits: ${inHistory.stdout.trim().split('\n').join(', ')})`,
    );
  }

  if (!existsSync(`${repoRoot}/${envExamplePath}`)) {
    failures.push(
      `${envExamplePath} is missing — it is the AUTHORITATIVE list of required env vars (08 §8, security-guide §10)`,
    );
  } else {
    const parsed = parseEnvExample(readFileSync(`${repoRoot}/${envExamplePath}`, 'utf8'));
    checked.envNames = parsed.names.length;
    if (parsed.names.length === 0) {
      failures.push(
        `${envExamplePath} declares no env var names — the name list parsed to nothing`,
      );
    }
    for (const offender of parsed.secretsWithValues) {
      failures.push(
        `${envExamplePath} assigns a VALUE to a secret-bearing name — values live only in the gitignored .env (security-guide §10, 08 §8): ${offender}`,
      );
    }
    for (const line of parsed.withValues) {
      notes.push(
        `${envExamplePath} carries a non-empty value on a non-secret name: ${line} — security-guide §10 / 08 §8 read literally say "names only"`,
      );
    }
  }

  return { ok: failures.length === 0, failures, notes, checked };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = scanSecrets();
  console.log(
    `secrets-scan: gitleaks ${result.checked.gitleaksVersion ?? '<unavailable>'}; ` +
      `working tree + full history scanned; ${result.checked.envNames} env var names declared.`,
  );
  for (const note of result.notes ?? []) console.log(`secrets-scan: NOTE ${note}`);
  for (const failure of result.failures) console.error(`secrets-scan: FAIL ${failure}`);
  process.exit(result.ok ? 0 : 1);
}
