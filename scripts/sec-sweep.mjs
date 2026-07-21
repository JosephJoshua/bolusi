// `pnpm sec:sweep` — the security release gate (task 28; 08-stack-and-repo §5.6, security-guide
// §12). One command, one report: correctness-under-malice, run at merge/release time.
//
// WHAT IT DOES, IN ORDER
//   1. builds (`tsc -b`) — every lane below imports cross-package dists (08 §5.6 convention);
//   2. runs the OWNING TEST LANES with a JSON reporter — the whole repo suite plus the
//      security-sweep lane (`packages/harness/vitest.security.config.ts`);
//   3. runs the SEC INVENTORY over those JSON reports: the §12 roll-up is the denominator, every
//      SEC id must have a test that actually PASSED, and the pending allowlist must be empty;
//   4. runs the repo SECRETS SCAN (working tree + full git history + `.env` discipline);
//   5. runs the DEPENDENCY PIN / LOCKFILE AUDIT against 08 §2 and security-guide §11.
//
// HOW IT REPORTS (CLAUDE.md §2.1). Every step's exit status is captured next to its output and
// echoed in the summary as `EXIT=<n>`. Nothing here infers success from a wrapper, a grep, or a
// pipeline's last command: a lane that cannot start is a FAILURE, never a skip, and a step that
// produces no report file fails rather than contributing zero assertions silently.
//
// AN HONEST RED IS A CORRECT RESULT. This gate is expected to exit non-zero while any SEC id is
// still owed (the pending allowlist) or any probe is red. Do not "fix" it by weakening a step —
// a release gate that fails because the release is not ready is the gate working (§2.11).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditInventory } from './sec-inventory.mjs';
import { auditDependencies } from './dependency-audit.mjs';
import { scanSecrets } from './secrets-scan.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'bolusi-sec-sweep-'));

/** The test lanes the inventory reads. Each writes its own JSON report. */
const LANES = [
  {
    name: 'repo suite (all vitest projects: unit, core, schemas, server, db-server, harness, i18n, ui)',
    args: ['vitest', 'run'],
  },
  {
    name: 'security-sweep lane (SEC-TENANT-04, SEC-SECRET-01, I-13)',
    args: ['vitest', 'run', '--config', 'packages/harness/vitest.security.config.ts'],
  },
];

const steps = [];

function record(name, status, detail) {
  steps.push({ name, status, detail });
  console.log(`\n── ${name} — EXIT=${status}`);
  if (detail) console.log(detail);
}

function run(name, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) {
    record(name, 127, `could not start: ${result.error.message}`);
    return { status: 127, stdout: '', stderr: String(result.error.message) };
  }
  const status = result.status ?? 1;
  const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .trimEnd()
    .split('\n')
    .slice(-25)
    .join('\n');
  record(name, status, tail);
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ── 1. build ────────────────────────────────────────────────────────────────────────────────────
run('build (tsc -b)', 'npx', ['tsc', '-b']);

// ── 2. test lanes, with JSON reports ────────────────────────────────────────────────────────────
const reports = [];
for (const [index, lane] of LANES.entries()) {
  const reportPath = join(workDir, `lane-${index}.json`);
  run(`test lane: ${lane.name}`, 'npx', [
    ...lane.args,
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ]);
  if (!existsSync(reportPath)) {
    // A lane that produced no report contributes zero assertions — which would let the inventory's
    // "has a passing test" check pass for the wrong reason if it were tolerated.
    record(`test lane report: ${lane.name}`, 1, `no JSON report was written to ${reportPath}`);
    continue;
  }
  reports.push({ lane: lane.name, report: JSON.parse(readFileSync(reportPath, 'utf8')) });
}

// ── 3. SEC inventory ────────────────────────────────────────────────────────────────────────────
const rawAllowlist = JSON.parse(
  readFileSync('packages/test-support/src/sec-pending-allowlist.json', 'utf8'),
);
const inventory = auditInventory({
  guideText: readFileSync('ai-docs/security-guide.md', 'utf8'),
  allowlist: Object.fromEntries(
    Object.entries(rawAllowlist).filter(([key]) => !key.startsWith('$')),
  ),
  reports,
});
record(
  'SEC inventory (security-guide §2.1.4 / §12)',
  inventory.ok ? 0 : 1,
  [
    `${inventory.checked.guideIds} ids parsed from the guide; ${inventory.checked.rollupIds} declared by the §12 roll-up (${inventory.checked.rollupEntries.join(' · ')}).`,
    `${inventory.checked.assertions} test assertions read from ${reports.length} lane report(s); ${inventory.checked.idsWithPass} ids have >=1 PASSING test.`,
    ...inventory.failures.map((failure) => `FAIL ${failure}`),
  ].join('\n'),
);

// ── 4. secrets scan ─────────────────────────────────────────────────────────────────────────────
const secrets = scanSecrets();
record(
  'secrets scan (security-guide §10)',
  secrets.ok ? 0 : 1,
  [
    `gitleaks ${secrets.checked.gitleaksVersion ?? '<unavailable>'}; working tree + full git history; ${secrets.checked.envNames} env var names declared.`,
    ...(secrets.notes ?? []).map((note) => `NOTE ${note}`),
    ...secrets.failures.map((failure) => `FAIL ${failure}`),
  ].join('\n'),
);

// ── 5. dependency pin / lockfile audit ──────────────────────────────────────────────────────────
const deps = auditDependencies({
  workspaceYaml: readFileSync('pnpm-workspace.yaml', 'utf8'),
  lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
  npmrcText: readFileSync('.npmrc', 'utf8'),
  guideText: readFileSync('ai-docs/security-guide.md', 'utf8'),
});
record(
  'dependency pin / lockfile audit (08 §2, security-guide §11)',
  deps.ok ? 0 : 1,
  [
    `${deps.checked.catalogEntries} catalog entries; ${deps.checked.pinsChecked} load-bearing pins; ${deps.checked.forbiddenChecked} forbidden packages; zod resolved: ${deps.checked.zodVersions.join(', ') || 'none'}.`,
    ...deps.failures.map((failure) => `FAIL ${failure}`),
  ].join('\n'),
);

// ── 6. frozen lockfile ──────────────────────────────────────────────────────────────────────────
run('lockfile in sync (pnpm install --frozen-lockfile)', 'pnpm', [
  'install',
  '--frozen-lockfile',
  '--ignore-scripts',
]);

rmSync(workDir, { recursive: true, force: true });

// ── summary ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n═══ sec:sweep summary ═══');
for (const step of steps) {
  console.log(`  EXIT=${step.status}  ${step.name}`);
}
const failed = steps.filter((step) => step.status !== 0);
console.log(
  failed.length === 0
    ? '\nsec:sweep: all steps EXIT=0.'
    : `\nsec:sweep: ${failed.length} step(s) failed — the release gate is RED, which is a correct outcome while any SEC id is still owed or any probe is red.`,
);
process.exit(failed.length === 0 ? 0 : 1);
