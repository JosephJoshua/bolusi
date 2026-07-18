// Semantic unused-export gate (task 68; CLAUDE.md §2.11 / testing-guide T-14, T-16).
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
//   1. POSITIVE CONTROL (denominator, T-14). `packages/test-support/src/knip-canary.ts`
//      exports one symbol nothing imports; the config lists it as a production `entry` so
//      `includeEntryExports` MUST report it. If it is absent from knip's output the sweep has
//      gone blind (setting dropped, glob broke, scan empty) — FAIL LOUD, never green.
//   2. FAIL ON ADDITIONS. The current tree carries a large accepted set of unused production
//      exports (built-ahead-of-consumer orphans of 43/49/50, test-only helpers, the decoys
//      tracked by 63/65) — too many to fix here. They are snapshotted in `knip-baseline.json`.
//      Any NEW unused production export (a fresh `canAttempt`) is not in the baseline → FAIL.
//   3. FAIL ON MASS DISAPPEARANCE. If most baselined findings vanish at once — knip scoped
//      down to one workspace would still satisfy (1) and (2) and pass green — that is either
//      blindness or a structural refactor; either way the denominator must be re-verified.
//      FAIL and demand `pnpm knip:baseline`. Small cleanups (below the limit) only warn.
//
// Lanes (documented, run directly with `pnpm sweep:exports` / `pnpm sweep:exports:all`):
//   --production --include exports  → unreachable from PRODUCTION entries (this gate's lane;
//                                     the `canAttempt` class lives here — tested but never
//                                     called in production).
//   --include exports               → unreachable from ANY entry, tests included (pure dead
//                                     code; a strict subset that MISSES tested decoys).
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
const KNIP_ARGS = ['--production', '--include', 'exports', '--no-progress', '--reporter', 'json'];

// The positive control lives in CODE, not in the baseline: a baseline can be edited to hide a
// regression, but this constant cannot be silenced without a reviewable diff to this file.
const CANARY = 'packages/test-support/src/knip-canary.ts#KNIP_SWEEP_CANARY';

/**
 * Run knip and return its findings as a sorted, de-duplicated `file#exportName` list.
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
  const keys = new Set();
  for (const issue of parsed.issues ?? []) {
    for (const exp of issue.exports ?? []) {
      keys.add(`${issue.file}#${exp.name}`);
    }
  }
  return [...keys].sort();
}

function loadBaseline() {
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return new Set(data.exports ?? []);
}

function writeBaseline(current) {
  if (!current.includes(CANARY)) {
    console.error(
      `check-unused-exports: refusing to write a baseline that does not contain the canary ` +
        `(${CANARY}). The sweep is blind — fix knip.json before regenerating (task 68 / §2.11).`,
    );
    process.exit(1);
  }
  const payload = {
    description:
      'Accepted unused production exports (task 68 gate). The gate fails on ADDITIONS to this ' +
      'set and on MASS DISAPPEARANCE from it; it does not fail on small cleanups. Regenerate ' +
      'with `pnpm knip:baseline` after intentionally changing the exported surface.',
    command: `knip ${KNIP_ARGS.join(' ')}`,
    canary: CANARY,
    denominator: current.length,
    exports: current,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `check-unused-exports: wrote ${current.length} accepted unused-export findings to ` +
      `knip-baseline.json (canary present).`,
  );
}

const update = process.argv.includes('--update');
const current = runKnip();

if (update) {
  writeBaseline(current);
  process.exit(0);
}

const baseline = loadBaseline();
const currentSet = new Set(current);
const additions = current.filter((k) => !baseline.has(k));
const resolved = [...baseline].filter((k) => !currentSet.has(k)).sort();
// A structural collapse (blindness, or a large refactor) must re-anchor the denominator; a
// handful of resolved findings is ordinary cleanup and only warrants a nudge.
const resolveLimit = Math.max(10, Math.ceil(baseline.size * 0.2));

const failures = [];
if (!currentSet.has(CANARY)) {
  failures.push(
    `POSITIVE CONTROL MISSING: knip did not report the canary export (${CANARY}). The sweep ` +
      `is blind — it is scanning nothing, or \`includeEntryExports\` / the entry globs broke ` +
      `(the exact way task 60 watched this sweep go green for the wrong reason). This is NOT a ` +
      `pass. Fix knip.json; do not silence this.`,
  );
}
if (additions.length > 0) {
  failures.push(
    `NEW unused production exports (${additions.length}) — exported, never called in ` +
      `production (the \`canAttempt\` class). Wire them up, delete them, or — if intentionally ` +
      `built ahead of a consumer — run \`pnpm knip:baseline\` to accept them WITH a reason:\n` +
      additions.map((k) => `    + ${k}`).join('\n'),
  );
}
if (resolved.length > resolveLimit) {
  failures.push(
    `MASS DISAPPEARANCE: ${resolved.length} baselined findings are gone (limit ${resolveLimit}). ` +
      `Either the sweep silently narrowed (blindness) or a large refactor landed — both require ` +
      `re-verifying the denominator. Confirm knip still scans the whole tree, then re-anchor ` +
      `with \`pnpm knip:baseline\`.`,
  );
}

console.log(
  `check-unused-exports: knip production lane flagged ${current.length} unused exports ` +
    `(baseline ${baseline.size}); canary ${currentSet.has(CANARY) ? 'present' : 'MISSING'}; ` +
    `+${additions.length} new / -${resolved.length} resolved.`,
);

if (failures.length > 0) {
  console.error(`\ncheck-unused-exports: FAILED (task 68 / §2.11)\n\n${failures.join('\n\n')}`);
  process.exit(1);
}

if (resolved.length > 0) {
  console.log(
    `check-unused-exports: note — ${resolved.length} baselined export(s) are now used or gone; ` +
      `prune with \`pnpm knip:baseline\` when convenient.`,
  );
}
console.log('check-unused-exports: no new unused production exports; sweep is not blind.');
