// `pnpm verify` — run what CI's push-triggered jobs run, locally, and read the result (task 142).
//
// THE BUG THIS REPLACES
// ---------------------
// `main`'s CI was RED for 30+ consecutive runs across more than a day while every local gate said
// green. Nobody skipped a check; the checks people ran were a DIFFERENT SET from the ones CI runs.
// `pnpm lint` is not the `lint` job (that job also runs `pnpm i18n:check`). `pnpm test` was never
// run at all by the agents landing work; nothing local ran `db:codegen && git diff --exit-code`.
//
// SO THIS COMMAND DOES NOT CONTAIN A LIST OF COMMANDS. It parses `.github/workflows/ci.yml`,
// takes each push-triggered step's `run:` text VERBATIM, and executes it in ci.yml's own job order.
// The only thing checked in here is the DECISION per step (run locally / skip because it provisions
// a runner), and `scripts/ci-parity.mjs` proves that decision set is total in both directions.
// Step 0 below runs that proof before anything else, so the fast tier cannot outrun its own gate.
//
// TIERS — AND WHY THE FAST ONE ANNOUNCES WHAT IT DEFERRED
// ------------------------------------------------------
// Full parity is minutes: `pnpm test` boots two Postgres testcontainers and includes the chaos
// lane, `sec:sweep` runs the whole repo suite twice with JSON reporters, `codegen-diff` migrates a
// real database. That is too slow to run before every commit, and a gate too slow to run is a gate
// nobody runs. So:
//   `pnpm verify`       — FAST. Static analysis + the lanes that need no container. Per-commit.
//   `pnpm verify:full`  — every push-triggered step. MANDATORY before merge to `main`, and after
//                         any change to a migration, a generated file, ci.yml, or a test script.
// The fast run PRINTS EVERY STEP IT DEFERRED, by name, with the command that runs them. A command
// that silently skips steps is a worse version of the bug being fixed here — it would hand back the
// same false "green locally" with a tool's authority behind it.
//
// REPORTING (CLAUDE.md §2.1)
// --------------------------
// Every step's status is captured next to its output and echoed as `EXIT=<n>`. Nothing infers
// success from a wrapper or a pipeline's last command. The summary splits failures two ways —
// UNEXPECTED vs OWED — because `security-sweep` has been red since it landed and always will be
// until two SEC ids are discharged, and THAT PERMANENT RED IS WHY THE OTHER FOUR FAILURES WENT
// UNREAD FOR A DAY (task 142). OWED is the one by-design red (D21's SEC allowlist); it does NOT fail
// the run. Everything else red is UNEXPECTED — a regression to read. An always-red run teaches
// people to stop reading runs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  auditParity,
  EXPECTED,
  executionPlan,
  loadWorkflow,
  REPO_ROOT,
  SKIP_REASONS,
  STEP_POLICY,
} from './ci-parity.mjs';

const argv = process.argv.slice(2);
const tier = argv.includes('--full') ? 'full' : 'fast';
const listOnly = argv.includes('--list');
const unknown = argv.filter((arg) => !['--full', '--fast', '--list'].includes(arg));
if (unknown.length > 0) {
  console.error(
    `verify: unknown argument(s) ${unknown.join(' ')} — usage: pnpm verify [--full] [--list]`,
  );
  process.exit(2);
}

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const rule = (label) => `\n${'─'.repeat(4)} ${label} ${'─'.repeat(Math.max(2, 92 - label.length))}`;

/** @type {Array<{ name: string, status: number, classification: string, detail: string }>} */
const results = [];

function record(name, status, classification, detail = '') {
  results.push({ name, status, classification, detail });
  console.log(
    `\n${bold(`EXIT=${status}`)}  ${name}${classification === 'PASS' ? '' : `  [${classification}]`}`,
  );
  if (detail !== '') console.log(detail);
}

// ── step 0: the environment CI's skipped steps provision ─────────────────────────────────────────
//
// Every `corepack enable` / `setup-node` step is skipped locally as RUNNER_PROVISIONING. That skip
// is a CLAIM — "this machine is already provisioned equivalently" — and a claim nobody checks is
// exactly the shape CLAUDE.md §2.11 warns about. So it is checked: a Node or pnpm mismatch against
// the versions CI pins is reported here rather than surfacing later as an unexplained diff.
//
// A CHECK IS SCOPED TO THE TIER THAT NEEDS IT. `gitleaks` is provisioned by CI for specific jobs, and
// the local steps that need it are all `full`. Failing the FAST tier over a binary no fast step will
// invoke makes the per-commit gate red for a reason unrelated to the commit — and a gate that reds
// for irrelevant reasons is one people stop reading, which is the exact disease this file treats.
// So a missing gitleaks is a PROBLEM only when a step that needs it is in THIS run's plan; otherwise
// it is a NOTE that names the deferred steps it will break, so it is deferred visibly, never hidden.
const GITLEAKS_JOBS = new Set(
  STEP_POLICY.filter((entry) => /gitleaks/i.test(entry.key)).map((entry) => entry.job),
);

/**
 * @param {{ included: Array<{job: string, key: string}>, deferred: Array<{job: string, key: string}> }} planned
 */
function checkToolchain(planned) {
  const problems = [];
  const notes = [];
  const warnings = [];
  const nvmrcPath = resolve(REPO_ROOT, '.nvmrc');
  if (!existsSync(nvmrcPath)) {
    problems.push('.nvmrc is missing, but ci.yml pins node via `node-version-file: .nvmrc`');
  } else {
    const wanted = readFileSync(nvmrcPath, 'utf8').trim().replace(/^v/, '');
    const actual = process.versions.node;
    const sameMajor = wanted.split('.')[0] === actual.split('.')[0];
    (sameMajor ? notes : problems).push(
      `node ${actual} local vs ${wanted} in .nvmrc (CI uses .nvmrc)${sameMajor ? '' : ' — MAJOR MISMATCH'}`,
    );
  }
  const wantedPnpm = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  ).packageManager;
  const pnpmVersion = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  const actualPnpm = (pnpmVersion.stdout ?? '').trim();
  if (pnpmVersion.status !== 0) {
    problems.push(
      `\`pnpm --version\` exited ${pnpmVersion.status ?? 'null'} — corepack is what CI uses to provide it`,
    );
  } else if (wantedPnpm !== `pnpm@${actualPnpm}`) {
    problems.push(`pnpm ${actualPnpm} local vs ${wantedPnpm} in package.json#packageManager`);
  } else {
    notes.push(`pnpm ${actualPnpm} matches ${wantedPnpm}`);
  }
  // SEC-SECRET-02's fixture test shells out to gitleaks and FAILS (never skips) when it is absent,
  // so a missing binary predicts a red for the steps that reach it — and ONLY for those steps.
  const label = (item) => `${item.job} / ${item.key}`;
  const needs = planned.included.filter((item) => GITLEAKS_JOBS.has(item.job));
  const willNeed = planned.deferred.filter((item) => GITLEAKS_JOBS.has(item.job));
  const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (gitleaks.error === undefined) {
    notes.push(`gitleaks ${(gitleaks.stdout ?? '').trim()} on PATH`);
  } else if (needs.length > 0) {
    problems.push(
      `gitleaks is not on PATH, and this run EXECUTES ${needs.map(label).join(' · ')}, which needs it — SEC-SECRET-02 fails hard rather than skipping`,
    );
  } else {
    warnings.push(
      `gitleaks is NOT on PATH. No step in this tier invokes it, so this is not a failure HERE — but ${
        willNeed.length === 0
          ? 'the CI jobs that install it'
          : `\`pnpm verify:full\` will run ${willNeed.map(label).join(' · ')}, which`
      } will fail on this machine until it is installed. CI provisions it for: ${[...GITLEAKS_JOBS].join(', ')}.`,
    );
  }
  return { problems, notes, warnings };
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────

const workflow = loadWorkflow();
const parity = auditParity(workflow);
const plan = executionPlan(workflow, tier);

console.log(rule(`pnpm verify — ${tier.toUpperCase()} tier`));
console.log(
  `derived from .github/workflows/ci.yml: ${workflow.stats.jobs} jobs / ${workflow.stats.steps} steps; ` +
    `${parity.checked.pushJobs.length} push-triggered job(s) -> ${parity.checked.ciSteps} step(s).`,
);
console.log(
  `this run executes ${plan.included.length} of them; ${parity.checked.skipped} are runner provisioning ` +
    `and ${plan.deferred.length} are deferred to \`pnpm verify:full\`.`,
);

if (listOnly) {
  for (const item of plan.included) console.log(`  RUN   [${item.tier}] ${item.job} / ${item.key}`);
  for (const item of plan.deferred) console.log(`  DEFER [${item.tier}] ${item.job} / ${item.key}`);
  for (const entry of STEP_POLICY.filter((policy) => policy.mode === 'skip')) {
    console.log(`  SKIP  [${entry.why}] ${entry.job} / ${entry.key}`);
  }
  process.exit(parity.ok ? 0 : 1);
}

// ── step 0 (always, both tiers): the drift gate ──────────────────────────────────────────────────
record(
  'ci.yml <-> local parity (scripts/ci-parity.mjs — the drift gate)',
  parity.ok ? 0 : 1,
  parity.ok ? 'PASS' : 'UNEXPECTED',
  [
    `${parity.checked.policyEntries} policy entries cover ${parity.checked.ciSteps} push-triggered ci.yml step(s): ` +
      `${parity.checked.fast} fast + ${parity.checked.full} full + ${parity.checked.skipped} skipped.`,
    ...parity.failures.map((failure) => `FAIL ${failure}`),
  ].join('\n'),
);

const toolchain = checkToolchain(plan);
record(
  'local toolchain vs the versions ci.yml provisions',
  toolchain.problems.length === 0 ? 0 : 1,
  toolchain.problems.length === 0 ? 'PASS' : 'UNEXPECTED',
  [
    ...toolchain.notes.map((note) => `ok   ${note}`),
    ...toolchain.warnings.map((warning) => `NOTE ${warning}`),
    ...toolchain.problems.map((problem) => `FAIL ${problem}`),
  ].join('\n'),
);

// A broken parity model makes every number below meaningless — stop rather than report them.
if (!parity.ok) {
  console.error(
    '\nverify: the drift gate is RED. Fix STEP_POLICY before trusting any result below it.',
  );
  process.exit(1);
}

// ── the derived steps ────────────────────────────────────────────────────────────────────────────
//
// GitHub runs an unqualified `run:` on Linux with `bash -e {0}` — no `-o pipefail` unless the step
// declares `shell: bash`. Matching that exactly matters: a multi-line step aborts on its first
// failing command in CI, and a local runner that did not would report a different verdict for the
// same text.
for (const item of plan.included) {
  const label = `${item.job} / ${item.key}`;
  const started = Date.now();
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', item.command], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: 256 * 1024 * 1024,
  });
  const status = result.error !== undefined ? 127 : (result.status ?? 1);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const tail = output.trimEnd().split('\n').slice(-20).join('\n');

  let classification = 'PASS';
  let detail = `$ ${item.command.split('\n').join('\n$ ')}\n(${seconds}s)\n${tail}`;

  const expected = item.expect === undefined ? undefined : EXPECTED[item.expect];
  if (expected !== undefined && status === 0) {
    // An exemption that outlived the thing it excused is a false assurance, not a convenience: the
    // day SEC-AUTH-09/10 are discharged, sec:sweep goes green and this reds itself as stale.
    classification = 'UNEXPECTED';
    detail += `\n\nSTALE EXEMPTION: this step is recorded in EXPECTED.${item.expect} (${expected.kind}: ${expected.ids.join(', ')}, ${expected.owner}) but it PASSED. Delete the entry — an exemption must not outlive its cause.`;
  } else if (expected !== undefined) {
    // OWED is the only exemption kind; its assert() must confirm the red is the recorded one.
    const scoped = expected.assert(output);
    classification = scoped.ok ? 'OWED' : 'UNEXPECTED';
    detail += scoped.ok
      ? `\n\nOWED (${expected.ids.join(', ')} — ${expected.owner}): ${scoped.detail}`
      : `\n\nRECORDED AS OWED (${expected.ids.join(', ')}) BUT THE FAILURE DOES NOT MATCH IT: ${scoped.detail}`;
  } else if (status !== 0) {
    classification = 'UNEXPECTED';
  }
  record(label, status, classification, detail);
}

// ── summary ──────────────────────────────────────────────────────────────────────────────────────

console.log(rule('verify summary'));
for (const step of results) {
  console.log(`  EXIT=${step.status}  ${step.classification.padEnd(10)} ${step.name}`);
}

const unexpected = results.filter((step) => step.classification === 'UNEXPECTED');
const owed = results.filter((step) => step.classification === 'OWED');

if (owed.length > 0) {
  console.log(rule('OWED — red by design, and this red is NOT news'));
  for (const step of owed) {
    const entry = Object.values(EXPECTED).find((candidate) =>
      step.detail.includes(candidate.ids[0]),
    );
    console.log(
      `  ${step.name}\n    ids: ${entry?.ids.join(', ')}\n    owner: ${entry?.owner}\n    ${entry?.note}`,
    );
  }
  console.log(
    '  These do NOT fail this run. They are the reason a permanently-red job must be labelled:',
  );
  console.log('  four real failures hid behind this one for a day (task 142).');
}
if (unexpected.length > 0) {
  console.log(rule('UNEXPECTED — read these first'));
  for (const step of unexpected) console.log(`  EXIT=${step.status}  ${step.name}`);
}

if (tier === 'fast') {
  console.log(rule(`NOT RUN by this fast tier — ${plan.deferred.length} step(s)`));
  for (const item of plan.deferred) console.log(`  ${item.job} / ${item.key}`);
  console.log(
    '\n  `pnpm verify` is the per-commit tier. It is NOT a merge gate and it does NOT mean CI is green.',
  );
  console.log('  Run `pnpm verify:full` before merging to main, and after touching a migration,');
  console.log('  a generated file, .github/workflows/ci.yml, or any `test:*` script.');
}

console.log(rule('lanes no local command can reproduce'));
console.log(
  `  ${parity.checked.dispatchOnlyJobs.join(', ')} — schedule / workflow_dispatch only, and they need an`,
);
console.log(
  '  Android AVD and a macOS+Xcode runner respectively. Nothing here is evidence about them.',
);
for (const [name, why] of Object.entries(SKIP_REASONS)) {
  const count = STEP_POLICY.filter((entry) => entry.why === name).length;
  console.log(`  ${count} step(s) skipped as ${name}: ${why}`);
}

console.log(rule('after you push to main'));
console.log(
  '  Run `pnpm ci:status`. A local green is a statement about this machine, not about CI.',
);

const failed = unexpected.length;
console.log(
  failed === 0
    ? `\nverify(${tier}): no unexpected failures.${owed.length > 0 ? ` ${owed.length} owed step(s) red by design.` : ''}`
    : `\nverify(${tier}): ${unexpected.length} UNEXPECTED failure(s) — read them first.`,
);
process.exit(failed === 0 ? 0 : 1);
