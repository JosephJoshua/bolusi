// `pnpm sec:gate` — the REQUIRED security merge gate (task 28 / task 194 / D22; 08-stack-and-repo
// §5.6, security-guide §12). One command, one report: correctness-under-malice, run at merge time.
//
// It is the successor to `pnpm sec:sweep`. The only behavioural difference is the SEC INVENTORY step:
// this gate tolerates the ONE owed-forever red (SEC-AUTH-10, D21) by running the inventory result
// through `classifyInventoryForGate` — the standing pending-allowlist red is reported, not gated —
// while a real inventory regression still blocks. That is what lets this job be a GitHub-native
// REQUIRED check: it is GREEN today. The owed red itself is carried, honestly, by the NON-required
// `pnpm sec:owed` job (scripts/sec-owed.mjs), so a merge is never blocked by a debt Node/CI cannot
// discharge, and that debt is never hidden (§2.11).
//
// WHY THE SPLIT REPLACED A TOWER (task 194). SEC-AUTH-10's permanent red used to share ONE GitHub
// job conclusion (`security-sweep`) with the real checks, so a bespoke CI-log-parsing oracle
// (ci-parity.mjs / ci-status.mjs + `verify.mjs`) grew to tell the owed red from a real one. Splitting
// the job at the SOURCE — required gate here, owed reporter there — removes the reason that oracle
// existed; it and its suites were deleted with this file's introduction (D22).
//
// WHAT IT DOES, IN ORDER (identical to the old sweep except step 3's tolerance)
//   1. builds (`tsc -b`) — every lane below imports cross-package dists (08 §5.6 convention);
//   2. runs the OWNING TEST LANES with a JSON reporter — the whole repo suite plus the
//      security-sweep lane (`packages/harness/vitest.security.config.ts`);
//   3. runs the SEC INVENTORY over those JSON reports, then classifies: a real regression FAILS the
//      gate; the sanctioned pending red (SEC-AUTH-10) is reported and does NOT;
//   4. runs the repo SECRETS SCAN (working tree + full git history + `.env` discipline);
//   5. runs the DEPENDENCY PIN / LOCKFILE AUDIT against 08 §2 and security-guide §11;
//   6. re-checks the frozen lockfile.
//
// HOW IT REPORTS (CLAUDE.md §2.1). Every step's exit status is captured next to its output and
// echoed in the summary as `EXIT=<n>`. Nothing here infers success from a wrapper, a grep, or a
// pipeline's last command: a lane that cannot start is a FAILURE, never a skip, and a step that
// produces no report file fails rather than contributing zero assertions silently.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditDependencies } from './dependency-audit.mjs';
import {
  SEC_ALLOWLIST_PATH,
  SEC_GUIDE_PATH,
  auditInventory,
  classifyInventoryForGate,
  pendingAllowlistEntries,
} from './sec-inventory.mjs';
import { scanSecrets } from './secrets-scan.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'bolusi-sec-gate-'));

/** The test lanes the inventory reads. Each writes its own JSON report. */
const LANES = [
  {
    name: 'repo suite (all vitest projects: unit, core, schemas, server, db-server, harness, i18n, ui, mobile)',
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

// ── 3. SEC inventory, classified for the REQUIRED gate ────────────────────────────────────────────
// `auditInventory` alone is RED while any id is owed (the pending allowlist is non-empty).
// `classifyInventoryForGate` splits that result into the sanctioned owed red (reported, non-blocking)
// and everything a merge must block on — the three scopes 166/172/184 forced, now over the STRUCTURED
// result rather than a printed CI log (D22). The owed set is DERIVED from the same allowlist the
// non-required `pnpm sec:owed` reads, so the two jobs can never disagree about what is owed (task 184).
const inventory = auditInventory({
  guideText: readFileSync(SEC_GUIDE_PATH, 'utf8'),
  allowlist: pendingAllowlistEntries(JSON.parse(readFileSync(SEC_ALLOWLIST_PATH, 'utf8'))),
  reports,
});
const gate = classifyInventoryForGate(inventory);
record(
  'SEC inventory (security-guide §2.1.4 / §12) — required gate',
  gate.ok ? 0 : 1,
  [
    `${inventory.checked.guideIds} ids parsed from the guide; ${inventory.checked.rollupIds} declared by the §12 roll-up (${inventory.checked.rollupEntries.join(' · ')}).`,
    `${inventory.checked.assertions} test assertions read from ${reports.length} lane report(s); ${inventory.checked.idsWithPass} ids have >=1 PASSING test.`,
    gate.owedIds.length > 0
      ? `OWED (non-blocking; carried honestly by \`pnpm sec:owed\`): ${gate.owedIds.join(', ')}.`
      : 'OWED: none — the pending allowlist is empty.',
    ...gate.realFailures.map((failure) => `FAIL ${failure}`),
    ...(gate.unsanctionedOwedIds.length > 0
      ? [
          `FAIL an owed id is NOT sanctioned: ${gate.unsanctionedOwedIds.join(', ')} — the required gate blocks until it is discharged or sanctioned (task 184).`,
        ]
      : []),
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
  guideText: readFileSync(SEC_GUIDE_PATH, 'utf8'),
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
console.log('\n═══ sec:gate summary ═══');
for (const step of steps) {
  console.log(`  EXIT=${step.status}  ${step.name}`);
}
const failed = steps.filter((step) => step.status !== 0);
console.log(
  failed.length === 0
    ? '\nsec:gate: all steps EXIT=0 — the required security gate is GREEN. The owed SEC red (if any) is\n' +
        'reported by the non-required `pnpm sec:owed` job and does not gate this merge.'
    : `\nsec:gate: ${failed.length} step(s) failed — the REQUIRED security gate is RED. This is a real\n` +
        'regression to fix, NOT the owed SEC-AUTH-10 debt (that lives in `pnpm sec:owed`, non-blocking).',
);
process.exit(failed.length === 0 ? 0 : 1);
