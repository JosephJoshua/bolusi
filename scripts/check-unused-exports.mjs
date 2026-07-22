// Semantic unused-export AND unused-file gate (tasks 68/137; CLAUDE.md §2.11 / testing-guide
// T-14, T-16).
//
// WHY THIS IS NOT `knip && echo ok`: task 60 proved a grep sweep for exported-and-uncalled
// symbols cannot work — grep counts a MENTION as a CALL, so a false comment scored a dead
// function `canAttempt` as live and the sweep missed the one case it was written for. knip
// answers the question with the TypeScript language service instead of text. But a semantic
// sweep has its own failure mode, the dominant one in this repo: it goes BLIND and reports a
// confident, useless zero. Task 60 watched THIS sweep do it twice — `includeEntryExports`
// off (every package's `src/index.ts` re-exports invisible; `packages/core` reported zero)
// and a broken entry glob (whole workspaces unscanned). A green sweep that silently checks
// nothing is worse than no sweep. So this gate does three things knip alone does not:
//
//   1. POSITIVE CONTROL (denominator, T-14). One per half — see CANARIES below.
//   2. FAIL ON ADDITIONS. The current tree carries a large accepted set of unused production
//      exports (built-ahead-of-consumer orphans of 43/49/50, test-only helpers, the decoys
//      tracked by 63/65) and unused production files (the dead modules tracked by 133/135) —
//      too many to fix here. They are snapshotted in `knip-baseline.json`. Any NEW unused
//      production export (a fresh `canAttempt`) or FILE is not in the baseline → FAIL.
//   3. FAIL ON MASS DISAPPEARANCE. If most baselined findings vanish at once — knip scoped
//      down to one workspace would still satisfy (1) and (2) and pass green — that is either
//      blindness or a structural refactor; either way the denominator must be re-verified.
//      FAIL and demand `pnpm knip:baseline`. Small cleanups (below the limit) only warn.
//
// TASK 137 — THE FILE HALF, AND WHY THE EXPORT HALF COULD NOT SEE IT. Until 137 this gate read
// `issue.exports` only and ran `--include exports`. knip classifies a file it cannot reach from
// an entry as a FILE issue and then never enumerates that file's symbols: verified against knip
// 6.27.0's own JSON, the `files` and `exports` finding sets are DISJOINT (0 files in both). So
// four wholly-dead production modules — `apps/mobile/src/{push/registration,push/routes,
// session/shell-session,state/user-workspaces}.ts`, the subject of tasks 133/135 — were invisible
// to the gate that exists to catch exactly that, while it printed `119 unused exports … sweep is
// not blind` / EXIT=0. A guard whose failure mode is "silently checks nothing" (§2.11).
//
// TASK 137 — THE SERVER ENTRY CONFIG. In production mode knip uses ONLY entry patterns suffixed
// with `!` (plus plugin production entries and package.json `start`); a config `entry` array
// REPLACES the defaults entirely. `apps/server`'s entries carried no `!`, so in this lane the
// workspace had NO entry at all and knip reported 78 of its 82 `src` files unused. Adding `!`
// (knip.json) cut apps/server's file findings 158 → 93 and — because a dead file's exports are
// never enumerated — surfaced 4 previously-invisible unused exports in
// `apps/server/src/middleware/auth.ts`, losing none. The file half is only trustworthy on top of
// that fix; without it the gate lands all-red and gets muted, which is worse than the blindness.
//
// TASK 137 — THE PARTITION, AND WHY IT IS FAIL-CLOSED. In production mode knip legitimately
// reports every test file, repo script, migration and config file as "unused": they are not
// reachable from a production entry BY DEFINITION. That is a category artifact, not a finding
// (158 of 196). Baselining them would red the gate on every task that adds a test — the fastest
// route to a muted gate. So findings are partitioned by NON_PRODUCTION_RULES below and only the
// production remainder is enforced. The partition is fail-CLOSED: a path is excluded only if it
// matches a named rule, so an unanticipated file class is ENFORCED (loud), never dropped (silent).
// Both directions of a broken partition are fatal: swallowing production paths takes the file
// canary with it (rule 1 below), and swallowing nothing floods the additions check.
//
// Lanes. THIS GATE runs exactly one knip process: `--production --include exports,files` (see
// KNIP_ARGS — the literal argv, not a paraphrase). Verified on knip 6.27.0: adding `files` to
// `--include` leaves the export finding set byte-identical to `--include exports`, so the export
// half is unchanged by task 137. Two adjacent lanes exist for hand-running, and are NOT what the
// gate runs:
//   `pnpm sweep:exports`     = --production --include exports  → the gate's lane minus the file
//                              half; this is what was blind to the 133/135 modules.
//   `pnpm sweep:exports:all` = --include exports               → unreachable from ANY entry,
//                              tests included (pure dead code; a strict subset that MISSES tested
//                              decoys — and MISSES all four 133/135 files, which tests import).
//
// Regenerate the baseline after an intentional change: `pnpm knip:baseline` (reads knip's OWN
// output — §2.1 — never a summary).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, 'knip-baseline.json');
// The root workspace's bin shim — knip's package `exports` map hides ./package.json, so
// require.resolve('knip/package.json') fails; the pnpm-created shim is the stable handle.
const KNIP_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'knip');
const KNIP_ARGS = [
  '--production',
  '--include',
  'exports,files',
  '--no-progress',
  '--reporter',
  'json',
];

// The positive controls live in CODE, not in the baseline: a baseline can be edited to hide a
// regression, but these constants cannot be silenced without a reviewable diff to this file.
//
// EXPORT_CANARY is a knip `entry`, so it is always REACHABLE — which is precisely why it cannot
// stand in for the file half (an entry is never an unused file). FILE_CANARY is the opposite: not
// an entry, imported by nothing, so it must always be reported as an unused file. Two halves, two
// denominators; neither one covers the other.
const EXPORT_CANARY = 'packages/test-support/src/knip-canary.ts#KNIP_SWEEP_CANARY';
const FILE_CANARY = 'packages/test-support/src/knip-file-canary.ts';

// Files production mode cannot reach BY DEFINITION — recorded, counted and printed on every run,
// but not gate-enforced (see the partition note above). Order is irrelevant; names appear in the
// gate's output so a mis-partitioned path is traceable to the rule that claimed it.
const NON_PRODUCTION_RULES = [
  { name: 'test-dir', re: /(^|\/)(test|tests|__tests__|e2e-web)\// },
  { name: 'test-file', re: /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/ },
  { name: 'type-test-file', re: /(^|\/)[^/]+\.test-d\.ts$/ },
  { name: 'config-file', re: /(^|\/)[^/]+\.config\.[cm]?[jt]s$/ },
  { name: 'scripts-dir', re: /(^|\/)scripts\// },
  { name: 'migrations-dir', re: /(^|\/)migrations\// },
];

function classify(file) {
  return NON_PRODUCTION_RULES.find((rule) => rule.re.test(file))?.name ?? null;
}

/**
 * Run knip ONCE and return both halves of its findings:
 *   exports — sorted, de-duplicated `file#exportName` list.
 *   files   — production-unreachable files, split into the enforced production set and the
 *             non-production category artifacts (see NON_PRODUCTION_RULES).
 * knip exits 1 when it finds issues — that is EXPECTED here (we have a baseline of accepted
 * findings), so exit code is NOT the signal. A non-parseable stdout is: it means knip crashed
 * or mis-configured, and a blind gate must never treat that as "no findings".
 */
function runKnip() {
  if (!existsSync(KNIP_BIN)) {
    throw new Error(`knip binary not found at ${KNIP_BIN} — run \`pnpm install\` first.`);
  }
  const res = spawnSync(KNIP_BIN, KNIP_ARGS, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`knip failed to spawn: ${res.error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `knip did not emit parseable JSON (exit ${res.status}). This is a broken sweep, not an ` +
        `empty one — refusing to report green.\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
    );
  }
  const exportKeys = new Set();
  const enforcedFiles = new Set();
  const excludedFiles = new Map();
  for (const issue of parsed.issues ?? []) {
    for (const exp of issue.exports ?? []) {
      exportKeys.add(`${issue.file}#${exp.name}`);
    }
    // knip's JSON emits one record per file with a `files` array that is non-empty only when the
    // FILE itself is unreachable; its single element is `{ name: <same path as issue.file> }`.
    // Read the array (not `issue.file`) so a shape change surfaces as a missing canary, loudly,
    // rather than as a silently mis-attributed finding.
    for (const dead of issue.files ?? []) {
      const rule = classify(dead.name);
      if (rule === null) enforcedFiles.add(dead.name);
      else excludedFiles.set(dead.name, rule);
    }
  }
  return {
    exports: [...exportKeys].sort(),
    files: [...enforcedFiles].sort(),
    excluded: [...excludedFiles.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

function loadBaseline() {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (!Array.isArray(data.files)) {
    throw new Error(
      `knip-baseline.json has no \`files\` array — the unused-FILE half of this gate (task 137) ` +
        `has no denominator to compare against. Refusing to run half-blind; regenerate with ` +
        `\`pnpm knip:baseline\`.`,
    );
  }
  return { exports: new Set(data.exports ?? []), files: new Set(data.files) };
}

function writeBaseline(current) {
  const missing = [];
  if (!current.exports.includes(EXPORT_CANARY)) missing.push(`export canary (${EXPORT_CANARY})`);
  if (!current.files.includes(FILE_CANARY)) missing.push(`file canary (${FILE_CANARY})`);
  if (missing.length > 0) {
    console.error(
      `check-unused-exports: refusing to write a baseline that does not contain the ` +
        `${missing.join(' and the ')}. The sweep is blind — fix knip.json before regenerating ` +
        `(tasks 68/137 / §2.11).`,
    );
    process.exit(1);
  }
  const payload = {
    description:
      'Accepted unused production exports (task 68) and unused production FILES (task 137). The ' +
      'gate fails on ADDITIONS to either set and on MASS DISAPPEARANCE from either; it does not ' +
      'fail on small cleanups. Regenerate with `pnpm knip:baseline` after intentionally changing ' +
      'the exported surface or the reachable file set.',
    command: `knip ${KNIP_ARGS.join(' ')}`,
    canary: EXPORT_CANARY,
    fileCanary: FILE_CANARY,
    denominator: current.exports.length,
    fileDenominator: current.files.length,
    // The rule NAMES are recorded here as well as in code so a silent widening of the exclusion
    // set is a two-place reviewable diff (§2.11: the partition is fail-closed and must stay
    // auditable). The excluded COUNT is deliberately NOT recorded: it is build-state dependent
    // (unbuilt 158 vs post-`tsc -b` 84, because a resolvable `apps/server/vitest.config.ts` makes
    // that workspace's tests reachable), so freezing it would be a stable-looking number with an
    // unstable provenance. The enforced set is build-state INDEPENDENT — verified: 39 findings,
    // +0/-0, both before and after a build — which is what makes it safe to gate on, given CI
    // runs `pnpm knip` with no build at all. It is printed on every run, never baselined.
    nonProductionRules: NON_PRODUCTION_RULES.map((r) => r.name),
    exports: current.exports,
    files: current.files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `check-unused-exports: wrote ${current.exports.length} accepted unused-export findings and ` +
      `${current.files.length} accepted unused-file findings to knip-baseline.json ` +
      `(both canaries present; ${current.excluded.length} non-production files excluded).`,
  );
}

/** Additions / mass-disappearance arithmetic, shared by both halves. */
function diff(current, baseline) {
  const currentSet = new Set(current);
  return {
    currentSet,
    additions: current.filter((k) => !baseline.has(k)),
    // A structural collapse (blindness, or a large refactor) must re-anchor the denominator; a
    // handful of resolved findings is ordinary cleanup and only warrants a nudge.
    resolved: [...baseline].filter((k) => !currentSet.has(k)).sort(),
    resolveLimit: Math.max(10, Math.ceil(baseline.size * 0.2)),
  };
}

const update = process.argv.includes('--update');
const current = runKnip();

if (update) {
  writeBaseline(current);
  process.exit(0);
}

const baseline = loadBaseline();
const exp = diff(current.exports, baseline.exports);
const files = diff(current.files, baseline.files);

const failures = [];
if (!exp.currentSet.has(EXPORT_CANARY)) {
  failures.push(
    `POSITIVE CONTROL MISSING (export half): knip did not report the canary export ` +
      `(${EXPORT_CANARY}). The sweep is blind — it is scanning nothing, or ` +
      `\`includeEntryExports\` / the entry globs broke (the exact way task 60 watched this sweep ` +
      `go green for the wrong reason). This is NOT a pass. Fix knip.json; do not silence this.`,
  );
}
if (!files.currentSet.has(FILE_CANARY)) {
  failures.push(
    `POSITIVE CONTROL MISSING (file half): knip did not report the unused-file canary ` +
      `(${FILE_CANARY}) in the enforced production set. The file sweep is blind — \`files\` was ` +
      `dropped from --include, \`issue.files\` is no longer read or changed shape, the entry/` +
      `project globs broke, or the non-production partition is swallowing \`src/\` paths. A file ` +
      `sweep that cannot see its own canary reports a confident zero (§2.11, task 137). This is ` +
      `NOT a pass — fix the sweep, never the canary.`,
  );
}
if (exp.additions.length > 0) {
  failures.push(
    `NEW unused production exports (${exp.additions.length}) — exported, never called in ` +
      `production (the \`canAttempt\` class). Wire them up, delete them, or — if intentionally ` +
      `built ahead of a consumer — run \`pnpm knip:baseline\` to accept them WITH a reason:\n` +
      exp.additions.map((k) => `    + ${k}`).join('\n'),
  );
}
if (files.additions.length > 0) {
  failures.push(
    `NEW unused production FILES (${files.additions.length}) — not reachable from any production ` +
      `entry, so nothing ships them and no export of theirs is even enumerated (task 137). Wire ` +
      `them up, delete them, or — if intentionally built ahead of a consumer — run ` +
      `\`pnpm knip:baseline\` to accept them WITH a reason:\n` +
      files.additions.map((k) => `    + ${k}`).join('\n'),
  );
}
if (exp.resolved.length > exp.resolveLimit) {
  failures.push(
    `MASS DISAPPEARANCE (export half): ${exp.resolved.length} baselined findings are gone (limit ` +
      `${exp.resolveLimit}). Either the sweep silently narrowed (blindness) or a large refactor ` +
      `landed — both require re-verifying the denominator. Confirm knip still scans the whole ` +
      `tree, then re-anchor with \`pnpm knip:baseline\`.`,
  );
}
if (files.resolved.length > files.resolveLimit) {
  failures.push(
    `MASS DISAPPEARANCE (file half): ${files.resolved.length} baselined unused files are gone ` +
      `(limit ${files.resolveLimit}). Either the sweep silently narrowed / the partition started ` +
      `swallowing production paths (blindness) or a large refactor landed — both require ` +
      `re-verifying the denominator. Confirm knip still scans the whole tree, then re-anchor ` +
      `with \`pnpm knip:baseline\`.`,
  );
}

console.log(
  `check-unused-exports: knip production lane flagged ${current.exports.length} unused exports ` +
    `(baseline ${baseline.exports.size}); canary ${exp.currentSet.has(EXPORT_CANARY) ? 'present' : 'MISSING'}; ` +
    `+${exp.additions.length} new / -${exp.resolved.length} resolved.`,
);
console.log(
  `check-unused-exports: knip production lane flagged ${current.files.length} unused production ` +
    `files (baseline ${baseline.files.size}) plus ${current.excluded.length} non-production files ` +
    `excluded by rule; file canary ${files.currentSet.has(FILE_CANARY) ? 'present' : 'MISSING'}; ` +
    `+${files.additions.length} new / -${files.resolved.length} resolved.`,
);

if (failures.length > 0) {
  console.error(
    `\ncheck-unused-exports: FAILED (tasks 68/137 / §2.11)\n\n${failures.join('\n\n')}`,
  );
  process.exit(1);
}

for (const [half, d, noun] of [
  ['export', exp, 'export(s)'],
  ['file', files, 'file(s)'],
]) {
  if (d.resolved.length > 0) {
    console.log(
      `check-unused-exports: note — ${d.resolved.length} baselined ${noun} in the ${half} half ` +
        `are now used or gone; prune with \`pnpm knip:baseline\` when convenient.`,
    );
  }
}
console.log(
  'check-unused-exports: no new unused production exports and no new unused production files; ' +
    'neither half of the sweep is blind.',
);
