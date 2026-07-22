// `pnpm ci:status` — read `main`'s ACTUAL CI result, per job, and say which reds are owed and which
// are news. Deliverable 4 of task 142: "read `gh run list` after pushing to main" as a command you
// run, not an intention you hold.
//
// WHY A COMMAND AND NOT A CHECKLIST LINE
// -------------------------------------
// `main`'s CI was red for 30+ consecutive runs across more than a day. The information was one
// `gh run list` away the whole time. A checklist line saying "check CI" had the same failure mode as
// the local gates it sat beside: it was obeyed as written and answered a different question.
// This prints the per-JOB breakdown, which is the level at which the three hidden causes were
// visible, and it labels the two reds that are NOT news so the ones that are cannot hide behind
// them.
//
// OWED COMES FROM ONE PLACE
// -------------------------
// The expected-red set is not restated here. It is derived from `STEP_POLICY` + `EXPECTED` in
// scripts/ci-parity.mjs — the same two tables `pnpm verify` classifies against — so a red that is
// excused locally and a red that is excused here cannot disagree. There is one expected-red
// category, OWED (D21's SEC allowlist); every other red is UNEXPECTED, a regression to read.
//
// ANY FAILURE TO *READ* IS A FAILURE, NEVER A SKIP
// ------------------------------------------------
// No `gh`, no auth, no runs, an unparseable response: each exits non-zero with the tool's own
// output. A status reader that returns "nothing to report" when it could not look is the exact
// green-for-the-wrong-reason shape CLAUDE.md §2.11 catalogues.
import { spawnSync } from 'node:child_process';

import { EXPECTED, STEP_POLICY, dispatchOnlyJobs, loadWorkflow } from './ci-parity.mjs';

const argv = process.argv.slice(2);
const branchArg = argv.find((arg) => arg.startsWith('--branch='));
const limitArg = argv.find((arg) => arg.startsWith('--limit='));
const branch = branchArg === undefined ? 'main' : branchArg.slice('--branch='.length);
const limit = limitArg === undefined ? 3 : Number.parseInt(limitArg.slice('--limit='.length), 10);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('ci:status: --limit must be a positive integer');
  process.exit(2);
}

/** @param {string[]} args */
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error !== undefined) {
    console.error(`ci:status: could not run \`gh ${args.join(' ')}\` — ${result.error.message}`);
    console.error(
      'ci:status: the GitHub CLI is how this repo reads its own CI. Install it and `gh auth login`.',
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`ci:status: \`gh ${args.join(' ')}\` EXIT=${result.status}`);
    console.error((result.stderr ?? '').trim() || (result.stdout ?? '').trim());
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout ?? '');
  } catch (error) {
    console.error(
      `ci:status: could not parse \`gh ${args.join(' ')}\` output as JSON — ${error.message}`,
    );
    console.error((result.stdout ?? '').slice(0, 2000));
    process.exit(1);
  }
}

// ── which reds are already accounted for ─────────────────────────────────────────────────────────

/** job id -> the EXPECTED entry that excuses its red, derived from the parity tables. */
const expectedByJob = new Map();
for (const entry of STEP_POLICY) {
  if (entry.expect === undefined) continue;
  expectedByJob.set(entry.job, { key: entry.expect, ...EXPECTED[entry.expect] });
}
// Only `security-sweep` carries an `expect` (OWED, D21). Note what is DELIBERATELY absent: `unit`
// and `chaos-harness` have no exemption. chaos-05 (task 127) once red them; 127 landed and they are
// green, so a future red there is a REGRESSION and shows as UNEXPECTED, never a standing exemption.

const workflow = loadWorkflow();
const dispatchOnly = new Set(dispatchOnlyJobs(workflow).map((job) => job.id));

// ── the runs ─────────────────────────────────────────────────────────────────────────────────────

const runs = gh([
  'run',
  'list',
  '--branch',
  branch,
  '--limit',
  String(limit),
  '--json',
  'databaseId,conclusion,status,createdAt,event,displayTitle,headSha',
]);

if (!Array.isArray(runs) || runs.length === 0) {
  console.error(
    `ci:status: gh returned NO runs for branch "${branch}" — that is not "all clear", it is "could not look".`,
  );
  process.exit(1);
}

console.log(`ci:status: ${runs.length} most recent run(s) on ${branch}\n`);

let unexpectedTotal = 0;
let unreadable = 0;

for (const run of runs) {
  const header = `run ${run.databaseId}  ${run.createdAt}  ${run.event}  ${run.status}/${run.conclusion || '—'}`;
  console.log(`${'═'.repeat(4)} ${header}`);
  console.log(`     ${run.displayTitle}`);
  if (run.status !== 'completed') {
    console.log(
      '     still running — no job verdict yet. Re-run `pnpm ci:status` when it completes.',
    );
    unreadable += 1;
    console.log('');
    continue;
  }

  const detail = gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
  const jobs = detail?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.error(
      `     could not read the job list for run ${run.databaseId} — treating as UNREADABLE, not as green.`,
    );
    unreadable += 1;
    console.log('');
    continue;
  }

  const failing = jobs.filter(
    (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped',
  );
  const owed = [];
  const unexpected = [];
  const nativeLanes = [];
  for (const job of failing) {
    if (dispatchOnly.has(job.name)) {
      nativeLanes.push(job);
      continue;
    }
    // OWED is the only expected-red category (D21's SEC allowlist). Everything else that reds is a
    // regression — including a now-fixed defect recurring — and must surface as UNEXPECTED.
    const expected = expectedByJob.get(job.name);
    if (expected === undefined) unexpected.push(job);
    else owed.push({ job, expected });
  }

  console.log(
    `     ${jobs.length} job(s): ${jobs.length - failing.length} green, ${failing.length} not green.`,
  );
  if (unexpected.length > 0) {
    console.log(`     UNEXPECTED (${unexpected.length}) — READ THESE FIRST:`);
    for (const job of unexpected) {
      console.log(
        `       ${job.conclusion.padEnd(9)} ${job.name}    gh run view ${run.databaseId} --log-failed --job ${job.databaseId}`,
      );
    }
  }
  for (const { job, expected } of owed) {
    console.log(`     OWED       ${job.name} — ${expected.ids.join(', ')}, ${expected.owner}`);
  }
  for (const job of nativeLanes) {
    console.log(
      `     NATIVE     ${job.name} (${job.conclusion}) — schedule/dispatch-only lane; no local command reproduces it`,
    );
  }
  if (failing.length === 0) console.log('     all green.');
  console.log('');
  unexpectedTotal += unexpected.length;
}

// ── the addendum: a lane that has NEVER completed is not evidence of anything ─────────────────────
//
// Task 142's addendum: `android-emulator` and `ios-simulator` are gated on schedule/dispatch, and
// for most of v0 NEITHER trigger had produced a completed run — the sole scheduled run was
// cancelled. Tasks sat `in-progress` citing a lane with no completed run behind it. "Never" has to
// be visible, so it is printed, live, rather than transcribed into a doc that goes stale.
console.log(`${'═'.repeat(4)} dispatch-only lanes — last COMPLETED run`);
const eventRuns = [];
for (const event of ['schedule', 'workflow_dispatch']) {
  const found = gh([
    'run',
    'list',
    '--workflow',
    'ci',
    '--event',
    event,
    '--limit',
    '20',
    '--json',
    'databaseId,conclusion,status,createdAt,event',
  ]);
  if (Array.isArray(found)) eventRuns.push(...found);
}
eventRuns.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

for (const jobName of dispatchOnly) {
  let reported = false;
  for (const run of eventRuns) {
    if (run.status !== 'completed') continue;
    const detail = gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
    const job = (detail?.jobs ?? []).find((candidate) => candidate.name === jobName);
    if (job === undefined || job.conclusion === 'skipped' || job.conclusion === null) continue;
    console.log(
      `     ${jobName.padEnd(18)} ${job.conclusion.padEnd(9)} ${run.createdAt}  (${run.event}, run ${run.databaseId})`,
    );
    reported = true;
    break;
  }
  if (!reported) {
    console.log(
      `     ${jobName.padEnd(18)} NEVER COMPLETED — no schedule/workflow_dispatch run has produced a verdict for this lane.`,
    );
    console.log(
      `     ${' '.repeat(18)} Nothing may cite it as evidence. Start one: gh workflow run ci --ref ${branch}`,
    );
  }
}

console.log('');
if (unreadable > 0) {
  console.log(
    `ci:status: ${unreadable} run(s) could not be read (still running or no job list) — that is not a green.`,
  );
}
console.log(
  unexpectedTotal === 0
    ? 'ci:status: no UNEXPECTED job failures in the runs read above.'
    : `ci:status: ${unexpectedTotal} UNEXPECTED job failure(s) — these are regressions, not the owed SEC ids.`,
);
process.exit(unexpectedTotal === 0 && unreadable === 0 ? 0 : 1);
