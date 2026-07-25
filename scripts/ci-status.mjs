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
// AND OWED IS NOT DECIDED BY JOB NAME (task 172)
// ----------------------------------------------
// A job carrying an `expect` entry is expected to fail for ONE recorded reason, not "however it
// happens to be red today". The name matching only NARROWS to the job that COULD be owed; whether
// this red actually IS the owed one is decided by fetching THIS job's log and running
// `EXPECTED[...].assert()` on it — the SAME oracle `pnpm verify` runs against the sweep's own output,
// so the two commands cannot disagree. A `security-sweep` red for a brand-new reason (a secrets-scan
// failure, a new SEC id, a frozen-lockfile break, a test lane) fails that assert and surfaces as
// UNEXPECTED, instead of hiding behind the permanent SEC red the way task 142's four failures hid
// behind it. This is the defect 142 existed to kill, surviving in the command 142 shipped.
//
// ANY FAILURE TO *READ* IS A FAILURE, NEVER A SKIP
// ------------------------------------------------
// No `gh`, no auth, no runs, an unparseable response: each exits non-zero with the tool's own
// output. A status reader that returns "nothing to report" when it could not look is the exact
// green-for-the-wrong-reason shape CLAUDE.md §2.11 catalogues. That rule reaches the owed check too:
// a log that cannot be fetched, comes back empty, or is truncated before the summary is UNEXPECTED,
// never a silent OWED — "could not look" is not "as expected" (task 154).
//
// AND IT SAYS WHICH QUESTION IT ANSWERED (task 154)
// ------------------------------------------------
// `gh run list --branch main` returns whatever ran most recently ON THAT BRANCH. That is NOT "did CI
// run my commit": a push whose run has not been created yet, a run on a task branch, and a manual
// dispatch are all invisible to it, and each would read as "main is clean" to someone who wanted
// "my work is clean". The gap is small and the misreading is easy, which is precisely the shape of
// the original outage — a check obeyed as written that answered a different question. So the scope
// is printed in the command's OWN output, every run's head SHA is shown, the local HEAD is compared
// against them, and `--sha=<sha>` turns "I want THIS commit" into a requirement that fails when the
// commit is absent instead of passing on a neighbour's green.
import { spawnSync } from 'node:child_process';

import { EXPECTED, STEP_POLICY, dispatchOnlyJobs, loadWorkflow } from './ci-parity.mjs';

/** The local checkout's HEAD, so the reader can see whether the runs below are even about it. */
function localHead() {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const name = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' });
  if (sha.status !== 0) return undefined;
  return { sha: (sha.stdout ?? '').trim(), branch: (name.stdout ?? '').trim() || '(detached)' };
}

/**
 * Run a `gh` call that MUST succeed to say anything at all (the run list, a run's job list). On any
 * failure it prints the tool's own output and exits non-zero — "could not look" is never a clean
 * read. The per-job LOG fetch is deliberately NOT this function: a failure to read one owed job's log
 * is classified (UNEXPECTED), not fatal to the whole command, so it goes through `fetchJobLog` below.
 * @param {string[]} args
 */
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

/**
 * Fetch ONE job's failed-step log via `gh run view <run> --log-failed --job <jobId>`. Returns a
 * RESULT rather than exiting the process: a job whose log cannot be read is UNEXPECTED (classified
 * and counted below), not a reason to abandon the whole status read. Distinguish "gh could not run"
 * / "gh exited non-zero" (a 404 job id lands here) from a successful fetch — the caller turns every
 * `ok:false` into a loud, non-owed verdict.
 * @param {string|number} runId
 * @param {string|number} jobId
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
function fetchJobLog(runId, jobId) {
  const result = spawnSync(
    'gh',
    ['run', 'view', String(runId), '--log-failed', '--job', String(jobId)],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) {
    return { ok: false, reason: `gh could not run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const why = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || '(no output)';
    return {
      ok: false,
      reason: `gh run view --log-failed --job ${jobId} EXIT=${result.status}: ${why.slice(0, 300)}`,
    };
  }
  return { ok: true, text: result.stdout ?? '' };
}

/**
 * `gh run view --log[-failed]` prefixes EVERY line with `<job name>\t<step name>\t<ISO timestamp> `
 * (and a BOM before the timestamp on a group's first line). The `EXPECTED[...].assert()` oracle in
 * ci-parity.mjs reads the RAW `pnpm sec:sweep` output — the exact bytes `pnpm verify` captures from
 * running the command — so the two commands share ONE oracle only if that runner column is removed
 * first. Strip the two tab-separated columns, an optional BOM, and the timestamp + its single
 * trailing space; leave the log line's own content (including its leading spaces) untouched.
 *
 * The strip is not itself the guard: if gh's format ever changed so that NOTHING matched, the lines
 * would pass through unstripped, `assert()` would find no `═══ sec:sweep summary ═══` at a line it
 * can read, and the verdict would be UNEXPECTED — loud, not a silent OWED. The oracle downstream is
 * what fails closed.
 * @param {string} logText
 * @returns {string}
 */
export function stripGhLogPrefix(logText) {
  return logText
    .split('\n')
    .map((line) =>
      line.replace(/^[^\t]*\t[^\t]*\t\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, ''),
    )
    .join('\n');
}

/**
 * Decide whether ONE failing job that carries an `expect` entry is genuinely OWED. This is the seam
 * task 172 closes: OWED stops meaning "the job name matched an exemption" and starts meaning "the
 * job's OWN log, run through the SAME `EXPECTED[...].assert()` oracle `pnpm verify` uses, confirms
 * the red is the recorded one".
 *
 * `fetchLog()` is injected so unit tests exercise every branch against saved/synthetic log text
 * without a live `gh`; the live caller passes a `() => fetchJobLog(runId, jobId)` closure. It returns
 * `{ ok:true, text }` or `{ ok:false, reason }`.
 *
 * A log that cannot be fetched, comes back empty, is truncated before the summary, or describes a
 * DIFFERENT failure is `owed:false` — never a silent OWED (task 154: "could not look" is not "as
 * expected"). `owed:false` carries a `detail` naming why, which the caller prints under UNEXPECTED.
 * @param {{ assert(output: string): { ok: boolean, detail: string } }} expected
 * @param {() => ({ ok: true, text: string } | { ok: false, reason: string })} fetchLog
 * @returns {{ owed: boolean, detail: string }}
 */
export function classifyExpectedRed(expected, fetchLog) {
  const fetched = fetchLog();
  if (!fetched.ok) {
    return {
      owed: false,
      detail: `could NOT read this job's log (${fetched.reason}) — "could not look" is not "as expected", so a red carrying an exemption stays UNEXPECTED until its own log confirms the owed reason`,
    };
  }
  if ((fetched.text ?? '').trim() === '') {
    return {
      owed: false,
      detail:
        "this job's log came back EMPTY — there is nothing to run the owed-red oracle against, and an empty read is never an owed red",
    };
  }
  const scoped = expected.assert(stripGhLogPrefix(fetched.text));
  return { owed: scoped.ok, detail: scoped.detail };
}

function main() {
  // EVERY FLAG IS `--name=value`, AND AN UNRECOGNISED ARGUMENT IS FATAL.
  // Not style — the `--sha=` requirement is opt-in, so a flag that fails to parse degrades to "no SHA
  // requested" and this command answers a question the caller did not ask, with exit 0. `--sha <sha>`
  // is the shape that bites: it is how `gh` itself is invoked a few lines below, so it is the form a
  // reader is primed to type. Mirrors scripts/verify.mjs's unknown-argument rejection.
  const FLAG_PREFIXES = ['--branch=', '--limit=', '--sha='];
  const argv = process.argv.slice(2);
  const unknownArgs = argv.filter((arg) => !FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
  if (unknownArgs.length > 0) {
    console.error(
      `ci:status: unknown argument(s) ${unknownArgs.join(' ')} — usage: pnpm ci:status [--branch=<name>] [--limit=<n>] [--sha=<sha>]`,
    );
    console.error(
      'ci:status: note the `=`. A space-separated `--sha <sha>` would otherwise be DROPPED silently and this command would exit 0 on a neighbouring commit’s green.',
    );
    process.exit(2);
  }
  const branchArg = argv.find((arg) => arg.startsWith('--branch='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const shaArg = argv.find((arg) => arg.startsWith('--sha='));
  const branch = branchArg === undefined ? 'main' : branchArg.slice('--branch='.length);
  const limit = limitArg === undefined ? 3 : Number.parseInt(limitArg.slice('--limit='.length), 10);
  const wantedSha = shaArg === undefined ? undefined : shaArg.slice('--sha='.length).trim();
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('ci:status: --limit must be a positive integer');
    process.exit(2);
  }
  if (wantedSha !== undefined && !/^[0-9a-f]{7,40}$/i.test(wantedSha)) {
    console.error(
      `ci:status: --sha must be a 7-40 character hex commit sha, got ${JSON.stringify(wantedSha)}`,
    );
    process.exit(2);
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

  // ── say which question these runs answer, BEFORE showing their verdicts ──────────────────────────
  const shas = new Set(runs.map((run) => String(run.headSha ?? '')));
  const head = localHead();
  console.log(
    `ci:status: read the ${runs.length} most recent run(s) on branch "${branch}" (gh run list --branch ${branch} --limit ${limit})`,
  );
  console.log(
    `  SCOPE: this answers "are branch ${branch}'s ${runs.length} most recent run(s) clean?" — NOT "did CI run my commit".`,
  );
  console.log(
    '  A run on any other branch, and a push whose run has not been created yet, are INVISIBLE here.',
  );
  if (head === undefined) {
    console.log('  local HEAD: could not read `git rev-parse HEAD` — no correlation is possible.');
  } else {
    console.log(
      `  local HEAD: ${head.sha.slice(0, 12)} on "${head.branch}" — ${
        shas.has(head.sha)
          ? 'IS among the runs below.'
          : 'is NOT among the runs below; nothing here is evidence about it.'
      }`,
    );
  }
  if (wantedSha !== undefined) {
    console.log(`  --sha=${wantedSha}: required to appear below, or this command fails.`);
  }
  console.log('');

  let unexpectedTotal = 0;
  let unreadable = 0;

  for (const run of runs) {
    const header = `run ${run.databaseId}  ${String(run.headSha ?? '').slice(0, 12)}  ${run.createdAt}  ${run.event}  ${run.status}/${run.conclusion || '—'}`;
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
      if (expected === undefined) {
        // No exemption names this job at all — any red here is a regression to read.
        unexpected.push({ job });
        continue;
      }
      // The job's NAME carries an exemption, but the exemption licenses ONE specific red, not "any
      // red in this job". Fetch THIS job's log and put it through the SAME oracle `pnpm verify` uses;
      // only a log that confirms the recorded red is OWED. A different failure, or a log we could not
      // read, is UNEXPECTED — never a silent OWED (task 172 / 154).
      const verdict = classifyExpectedRed(expected, () =>
        fetchJobLog(run.databaseId, job.databaseId),
      );
      if (verdict.owed) owed.push({ job, expected, detail: verdict.detail });
      else unexpected.push({ job, detail: verdict.detail });
    }

    console.log(
      `     ${jobs.length} job(s): ${jobs.length - failing.length} green, ${failing.length} not green.`,
    );
    if (unexpected.length > 0) {
      console.log(`     UNEXPECTED (${unexpected.length}) — READ THESE FIRST:`);
      for (const { job, detail } of unexpected) {
        console.log(
          `       ${job.conclusion.padEnd(9)} ${job.name}    gh run view ${run.databaseId} --log-failed --job ${job.databaseId}`,
        );
        // For a job that CARRIED an exemption but failed its log assert, say WHY it is not owed —
        // otherwise the reader cannot tell a genuine regression from a name that simply had no entry.
        if (detail !== undefined) console.log(`         ↳ ${detail}`);
      }
    }
    for (const { job, expected, detail } of owed) {
      console.log(`     OWED       ${job.name} — ${expected.ids.join(', ')}, ${expected.owner}`);
      // The assert's own words: which ids the LOG was actually red for, so an owed line is evidence,
      // not a label. (§2.11 — a guard states its own coverage.)
      if (detail !== undefined) console.log(`                log confirms: ${detail}`);
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

  // A requested SHA that is not in the set read is "could not look", not "clean" — the same rule the
  // rest of this file applies to a missing `gh`, a missing run, or an unparseable response.
  const shaMissing = wantedSha !== undefined && ![...shas].some((sha) => sha.startsWith(wantedSha));
  if (shaMissing) {
    console.error(
      `ci:status: --sha=${wantedSha} does NOT appear in the ${runs.length} run(s) read on "${branch}". ` +
        `That is not a green for that commit — it means no run for it was found. Widen with --limit, ` +
        `pass --branch=<its branch>, or wait for its run to be created.`,
    );
  }

  // THE LAST LINE MUST CARRY ITS OWN DENOMINATOR (T-14).
  // People read this command's final line and nothing else, so that line — not a caveat three lines
  // up, and not the exit code — is what has to be unmistakable. "No UNEXPECTED job failures in the
  // runs read" is TRUE over an empty set: three still-running runs means ZERO were inspected, and the
  // eye lands on an all-clear. That is the vacuous pass this whole task is about, one layer up from
  // the parse and expressed in prose. So the clean line states how many runs it actually inspected,
  // and anything that prevents a verdict — nothing inspected, a requested SHA absent, a real
  // regression — replaces it outright rather than sitting above it.
  const inspected = runs.length - unreadable;
  const blockers = [];
  if (inspected === 0) blockers.push(`0 of ${runs.length} run(s) inspected`);
  if (shaMissing) blockers.push(`--sha=${wantedSha} is not among the ${runs.length} run(s) read`);
  if (unexpectedTotal > 0) {
    blockers.push(
      `${unexpectedTotal} UNEXPECTED job failure(s) — regressions, not the owed SEC ids`,
    );
  }
  // The clean line leads with a word that MATCHES the denominator: a fully-inspected set is CLEAN, a
  // partially-inspected one is INCOMPLETE — so the eye never lands on "clean" for a set where some
  // runs went unread. The blocked line always leads with NO CLEAN VERDICT.
  const cleanLead = inspected === runs.length ? 'CLEAN' : 'INCOMPLETE';
  console.log(
    blockers.length === 0
      ? `ci:status: ${cleanLead} — ${inspected} of ${runs.length} run(s) on "${branch}" fully inspected, no UNEXPECTED job failures.`
      : `ci:status: NO CLEAN VERDICT — ${blockers.join('; ')}.`,
  );
  process.exit(blockers.length === 0 && unreadable === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
