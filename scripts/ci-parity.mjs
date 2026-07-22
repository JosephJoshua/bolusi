// The CI-parity model (task 142): what `.github/workflows/ci.yml` runs on a push, and what the
// local `pnpm verify` does about each of those steps.
//
// WHY THIS FILE EXISTS
// --------------------
// On 2026-07-21..22 `main`'s CI was RED for 30+ consecutive runs across more than a day while every
// local gate reported green. Three independent causes hid in there, and not one of them was a
// discipline failure: CLAUDE.md §2.1 ("read the tool's OWN output") was obeyed every time. The gap
// was that THE LOCAL TOOL SET IS NOT THE CI TOOL SET —
//   * CI's `lint` job runs `pnpm lint` AND `pnpm i18n:check`; locally people ran `pnpm lint`;
//   * CI's `db-client` job runs `db:codegen` and then `git diff --exit-code`; nothing local did;
//   * CI's `unit` job runs the WHOLE vitest project set, chaos lane included.
// "Green locally" was a true statement about a different question.
//
// THE STEP LIST IS DERIVED, NOT TRANSCRIBED
// -----------------------------------------
// Hand-syncing a local script against a workflow file is the defect, not the fix — it is the same
// mechanism that let the `lint` job grow a second command unnoticed. So `pnpm verify` does not
// contain a list of commands. It PARSES ci.yml, takes each push-triggered step's `run:` text
// VERBATIM, and executes that. A command that changes in CI changes locally on the next run with no
// edit here.
//
// What this file owns is the one thing that cannot be derived: the DECISION about each step —
// run it locally, or skip it because it provisions a runner rather than testing the repo. That
// decision set is `STEP_POLICY` below, and `auditParity()` proves the decision set is TOTAL:
//   * a ci.yml step with no policy entry           -> UNCOVERED (a new CI step nobody runs locally)
//   * a policy entry matching no ci.yml step       -> ORPHANED  (local claims coverage CI dropped)
//   * a skipped step whose body changed            -> STALE SKIP (the recorded reason may no longer hold)
// All three are failures. `packages/test-support/src/ci-parity.test.ts` is that gate in CI, and
// `pnpm verify` runs the same audit as its own step 0 so the fast tier cannot outrun it.
//
// WHY `run` ENTRIES CARRY NO FINGERPRINT AND `skip` ENTRIES DO
// -----------------------------------------------------------
// A `run` step's text is executed verbatim, so parity with CI is maintained BY CONSTRUCTION when it
// changes — a fingerprint there would be pure churn. A `skip` step's text is NOT executed, so its
// recorded reason ("this provisions the runner") is a claim about a body nobody re-reads. Change
// the body and the claim may silently stop being true. That is the `skip` fingerprint's job.
//
// THE PARSER IS NARROW ON PURPOSE, AND ASSERTS ITS OWN DENOMINATOR
// ---------------------------------------------------------------
// It reads the exact shape ci.yml has (2-space jobs, 6-space step dashes, block scalars) and
// REFUSES anything else rather than skipping it. The dominant failure mode of a hand-rolled parser
// is going blind and reporting a confident zero — CLAUDE.md §2.11 lists five gates that shipped
// green for exactly that reason. So `parseWorkflow` cross-checks its state machine against an
// INDEPENDENT regex count of job keys and step dashes, rejects a step with neither `run:` nor
// `uses:`, rejects an `if:` expression it cannot evaluate, and enforces floors. A parse that lost
// its place throws; it never returns a small number quietly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');

/** Structural floors — a parse below these lost its place (T-14: assert the denominator). */
const MIN_JOBS = 10;
const MIN_STEPS = 40;

// ── YAML: the narrow reader ──────────────────────────────────────────────────────────────────────

/**
 * Strip full-line `#` comments and blank lines, and trim trailing whitespace, so that a comment
 * edit inside ci.yml is not mistaken for a command change.
 * @param {string} text
 * @returns {string}
 */
function normalizeBody(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
    .join('\n');
}

/** 12 hex chars of sha256 — enough to notice an edit, short enough to paste into a policy entry. */
export function fingerprint(text) {
  return createHash('sha256').update(normalizeBody(text), 'utf8').digest('hex').slice(0, 12);
}

/**
 * Parse one step's body (already dedented to column 0) into its keys. Only `name`, `uses` and `run`
 * are extracted; every other key (`with:`, `env:`, `if:`) is retained in the raw body so a change to
 * it still moves the fingerprint.
 * @param {string[]} bodyLines
 * @returns {{ name?: string, uses?: string, run?: string }}
 */
function parseStepBody(bodyLines) {
  /** @type {{ name?: string, uses?: string, run?: string }} */
  const step = {};
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index];
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    // Only column-0 keys are step keys; anything indented belongs to the previous key's value.
    const key = line.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    if (key === null) continue;
    const [, keyName, rawValue] = key;
    const value = (rawValue ?? '').trim();
    if (/^[|>][-+]?$/.test(value)) {
      // Block scalar: consume the indented run of lines that follows and dedent by their minimum.
      const block = [];
      let cursor = index + 1;
      while (
        cursor < bodyLines.length &&
        (bodyLines[cursor].trim() === '' || /^\s/.test(bodyLines[cursor]))
      ) {
        block.push(bodyLines[cursor]);
        cursor += 1;
      }
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
      const indents = block
        .filter((line_) => line_.trim() !== '')
        .map((line_) => line_.length - line_.trimStart().length);
      const shift = indents.length === 0 ? 0 : Math.min(...indents);
      const text = block.map((line_) => line_.slice(shift)).join('\n');
      if (keyName === 'run') step.run = text;
      index = cursor - 1;
      continue;
    }
    if (keyName === 'name') step.name = value.replace(/^['"]|['"]$/g, '');
    if (keyName === 'uses') step.uses = value;
    if (keyName === 'run') step.run = value;
  }
  return step;
}

/**
 * Parse `.github/workflows/ci.yml` into jobs and steps.
 *
 * @param {string} text
 * @returns {{ jobs: Array<{ id: string, if?: string, steps: Array<{ index: number, name?: string, uses?: string, run?: string, body: string }> }>, stats: { jobs: number, steps: number, rawJobKeys: number, rawStepDashes: number } }}
 */
export function parseWorkflow(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) throw new Error('ci-parity: no top-level `jobs:` key in the workflow');

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const region = lines.slice(start + 1, end);
  if (region.some((line) => line.includes('\t'))) {
    throw new Error('ci-parity: the jobs region contains a TAB — this parser reads spaces only');
  }

  // INDEPENDENT counts, taken by regex over the raw region rather than by the state machine below.
  // If the walker loses its place it reports fewer jobs/steps than these and the parse THROWS,
  // instead of handing back a small number that every downstream check would pass vacuously.
  const rawJobKeys = region.filter((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)).length;
  const rawStepDashes = region.filter((line) => /^ {6}- /.test(line)).length;

  const jobs = [];
  /** @type {{ id: string, if?: string, steps: any[] } | null} */
  let job = null;
  let inSteps = false;
  /** @type {string[] | null} */
  let stepLines = null;

  const flushStep = () => {
    if (job === null || stepLines === null) return;
    const body = stepLines.join('\n');
    const parsed = parseStepBody(stepLines);
    if (parsed.run === undefined && parsed.uses === undefined) {
      throw new Error(
        `ci-parity: job "${job.id}" step #${job.steps.length + 1} has neither \`run:\` nor \`uses:\` — the parser lost its place`,
      );
    }
    job.steps.push({ index: job.steps.length, ...parsed, body });
    stepLines = null;
  };

  for (const line of region) {
    // A comment indented LESS than a step body (< 8) is structural — the running commentary between
    // jobs and between steps. One indented 8 or more belongs to the step body being accumulated
    // (e.g. the notes inside android-emulator's `script:` block) and is kept.
    if (/^\s*#/.test(line) && line.length - line.trimStart().length < 8) continue;
    const jobKey = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobKey !== null) {
      flushStep();
      job = { id: jobKey[1], steps: [] };
      jobs.push(job);
      inSteps = false;
      continue;
    }
    if (job === null) {
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      throw new Error(`ci-parity: content before the first job key: ${JSON.stringify(line)}`);
    }
    const jobIf = line.match(/^ {4}if:\s*(.+)$/);
    if (jobIf !== null) {
      flushStep();
      job.if = jobIf[1].trim();
      inSteps = false;
      continue;
    }
    if (/^ {4}steps:\s*$/.test(line)) {
      flushStep();
      inSteps = true;
      continue;
    }
    if (/^ {4}[A-Za-z0-9_.-]+:/.test(line)) {
      flushStep();
      inSteps = false;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {6}- /.test(line)) {
      flushStep();
      stepLines = [line.slice(8)];
      continue;
    }
    if (/^ {6}#/.test(line) || line.trim() === '') continue;
    if (stepLines !== null && /^ {8}/.test(line)) {
      stepLines.push(line.slice(8));
      continue;
    }
    if (stepLines !== null && line.trim() !== '') {
      throw new Error(
        `ci-parity: unexpected indentation inside job "${job.id}" steps: ${JSON.stringify(line)}`,
      );
    }
  }
  flushStep();

  const steps = jobs.reduce((total, entry) => total + entry.steps.length, 0);
  if (jobs.length !== rawJobKeys) {
    throw new Error(
      `ci-parity: walked ${jobs.length} jobs but the region has ${rawJobKeys} job keys — the parse is incomplete`,
    );
  }
  if (steps !== rawStepDashes) {
    throw new Error(
      `ci-parity: walked ${steps} steps but the region has ${rawStepDashes} step dashes — the parse is incomplete`,
    );
  }
  if (jobs.length < MIN_JOBS || steps < MIN_STEPS) {
    throw new Error(
      `ci-parity: parsed ${jobs.length} jobs / ${steps} steps, below the ${MIN_JOBS}/${MIN_STEPS} floor — a parse this small is blind, not clean`,
    );
  }
  for (const entry of jobs) {
    if (entry.steps.length === 0) {
      throw new Error(`ci-parity: job "${entry.id}" parsed with ZERO steps`);
    }
  }

  return { jobs, stats: { jobs: jobs.length, steps, rawJobKeys, rawStepDashes } };
}

/**
 * Does a job's `if:` let it run for `eventName`?
 *
 * Deliberately NOT a general GitHub-expression evaluator: it accepts the one shape ci.yml uses (a
 * disjunction of `github.event_name == '<event>'`) and THROWS on anything else. A partial evaluator
 * that guessed `true` would silently drop a lane from the parity set — the exact class of failure
 * this file exists to close.
 * @param {string} expression
 * @param {string} eventName
 * @returns {boolean}
 */
export function evaluateEventGate(expression, eventName) {
  const inner = expression
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
  const terms = inner.split('||').map((term) => term.trim());
  let result = false;
  for (const term of terms) {
    const comparison = term.match(/^github\.event_name\s*(==|!=)\s*'([a-z_]+)'$/);
    if (comparison === null) {
      throw new Error(
        `ci-parity: unsupported job \`if:\` expression ${JSON.stringify(expression)} — teach evaluateEventGate this shape rather than assuming it runs`,
      );
    }
    const [, operator, event] = comparison;
    result ||= operator === '==' ? eventName === event : eventName !== event;
  }
  return result;
}

/** The jobs a `push` to `main` actually starts. */
export function pushTriggeredJobs(workflow) {
  return workflow.jobs.filter((job) => job.if === undefined || evaluateEventGate(job.if, 'push'));
}

/** The jobs that only a `schedule` / `workflow_dispatch` starts — never on a push or a PR. */
export function dispatchOnlyJobs(workflow) {
  return workflow.jobs.filter((job) => job.if !== undefined && !evaluateEventGate(job.if, 'push'));
}

/** Stable identity of a step within its job: its `name:` if it has one, else its first command line. */
export function stepKey(step) {
  if (step.name !== undefined) return step.name;
  if (step.run !== undefined) return step.run.split('\n')[0].trim();
  return `uses ${step.uses}`;
}

// ── The decision set ─────────────────────────────────────────────────────────────────────────────

/**
 * `run` tiers. `fast` is the per-commit set — static analysis and the lanes that need no container
 * and no minutes. `full` adds every lane that boots Postgres/PGlite, builds, or sweeps the whole
 * repo suite. Both tiers run the SAME derived commands; the fast tier's own output NAMES every
 * step it deferred, because a command that silently skips work is a worse version of the bug this
 * task removes.
 */
export const TIERS = ['fast', 'full'];

/**
 * Why a CI step is not executed locally. Every skip names a category, and the category is the
 * claim being made — not "it's fine", but "this provisions a GitHub runner" or "this is a hosted
 * action with no local equivalent". A skip whose body changes fails the audit (see the header).
 */
export const SKIP_REASONS = {
  RUNNER_PROVISIONING:
    'provisions the GitHub runner (checkout / corepack / setup-node / apt-level installs). A developer machine is already provisioned; `pnpm verify` asserts the node + pnpm versions itself instead.',
  HOSTED_ACTION:
    'a hosted GitHub Action with no local CLI equivalent. Named here so it is visibly NOT covered rather than silently assumed.',
};

/**
 * ONE ENTRY PER PUSH-TRIGGERED ci.yml STEP. `auditParity` fails if that is not true in either
 * direction.
 *
 * `job` + `key` locate the step (`key` is its `name:`, else its first command line).
 * `mode`   'run'  -> execute the step's ci.yml `run:` text verbatim, in `tier`.
 *          'skip' -> do not execute; `why` must name a SKIP_REASONS category and `body` must be the
 *                    current fingerprint of the step (so an edit forces a re-read).
 * `expect` (optional) -> this step is expected to fail BY DESIGN (OWED); see `EXPECTED` below.
 */
export const STEP_POLICY = [
  // ── install (stage 1) ─────────────────────────────────────────────────────────────────────────
  {
    job: 'install',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'install',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'install',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  { job: 'install', key: 'pnpm install --frozen-lockfile', mode: 'run', tier: 'fast' },
  { job: 'install', key: 'node scripts/check-single-zod.mjs', mode: 'run', tier: 'fast' },
  { job: 'install', key: 'node scripts/check-forbidden-packages.mjs', mode: 'run', tier: 'fast' },
  { job: 'install', key: 'node scripts/check-no-control-bytes.mjs', mode: 'run', tier: 'fast' },
  { job: 'install', key: 'node scripts/check-test-script-builds.mjs', mode: 'run', tier: 'fast' },

  // ── lint (stage 2) — `pnpm i18n:check` is the step a day of red CI was hiding behind ──────────
  {
    job: 'lint',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'lint',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'lint',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'lint',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'lint', key: 'pnpm lint', mode: 'run', tier: 'fast' },
  { job: 'lint', key: 'pnpm i18n:check', mode: 'run', tier: 'fast' },

  // ── unused-exports ────────────────────────────────────────────────────────────────────────────
  {
    job: 'unused-exports',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'unused-exports',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'unused-exports',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'unused-exports',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'unused-exports', key: 'pnpm knip', mode: 'run', tier: 'fast' },

  // ── typecheck (stage 3) ───────────────────────────────────────────────────────────────────────
  {
    job: 'typecheck',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'typecheck',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'typecheck',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'typecheck',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'typecheck', key: 'pnpm typecheck', mode: 'run', tier: 'fast' },

  // ── unit (stage 4+5) — the WHOLE vitest project set, chaos lane included ──────────────────────
  {
    job: 'unit',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'unit',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'unit',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'unit',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  {
    job: 'unit',
    key: 'install gitleaks (checksum-pinned)',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '22550cdd57c0',
  },
  { job: 'unit', key: 'pnpm test', mode: 'run', tier: 'full' },

  // ── db-client — the codegen diff nothing local was running ────────────────────────────────────
  {
    job: 'db-client',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'db-client',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'db-client',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'db-client',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'db-client', key: 'pnpm -F @bolusi/db-client build', mode: 'run', tier: 'fast' },
  {
    job: 'db-client',
    key: 'unit + driver conformance (better-sqlite3 lane, SQLCipher off by design)',
    mode: 'run',
    tier: 'fast',
  },
  {
    job: 'db-client',
    key: 'client codegen types are up to date (10-db §11.4)',
    mode: 'run',
    tier: 'fast',
  },

  // ── jcs-vectors-hermes (stage 6) ──────────────────────────────────────────────────────────────
  {
    job: 'jcs-vectors-hermes',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'jcs-vectors-hermes',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'jcs-vectors-hermes',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'jcs-vectors-hermes',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'jcs-vectors-hermes', key: 'pnpm test:jcs-hermes', mode: 'run', tier: 'full' },

  // ── ed25519-interop (stage 7) ─────────────────────────────────────────────────────────────────
  {
    job: 'ed25519-interop',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'ed25519-interop',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'ed25519-interop',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'ed25519-interop',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'ed25519-interop', key: 'pnpm test:ed25519-interop', mode: 'run', tier: 'full' },

  // ── server-integration (stage 8) — real PG16 in a testcontainer ───────────────────────────────
  {
    job: 'server-integration',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'server-integration',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'server-integration',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'server-integration',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  {
    job: 'server-integration',
    key: 'server integration suite vs real Postgres 16 (testcontainers, D16)',
    mode: 'run',
    tier: 'full',
  },

  // ── gitleaks — the hosted full-history action ─────────────────────────────────────────────────
  {
    job: 'gitleaks',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '05d4b205fa44',
  },
  {
    job: 'gitleaks',
    key: 'uses gitleaks/gitleaks-action@v2',
    mode: 'skip',
    why: 'HOSTED_ACTION',
    body: 'b5f17b75076d',
  },

  // ── rls-witness (stage 9) — MERGE GATE ────────────────────────────────────────────────────────
  {
    job: 'rls-witness',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'rls-witness',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'rls-witness',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'rls-witness',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'rls-witness', key: 'node scripts/check-tenant-context.mjs', mode: 'run', tier: 'fast' },
  {
    job: 'rls-witness',
    key: 'RLS suite vs real Postgres 16 (testcontainers, D16)',
    mode: 'run',
    tier: 'full',
  },

  // ── codegen-diff — needs a migrated Postgres; local runs go through scripts/db-lane.mjs ───────
  {
    job: 'codegen-diff',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'codegen-diff',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'codegen-diff',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'codegen-diff',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'codegen-diff', key: 'pnpm db:migrate', mode: 'run', tier: 'full' },
  { job: 'codegen-diff', key: 'pnpm db:codegen:check', mode: 'run', tier: 'full' },
  { job: 'codegen-diff', key: 'pnpm db:codegen', mode: 'run', tier: 'full' },
  { job: 'codegen-diff', key: 'fail on generated-type drift', mode: 'run', tier: 'full' },

  // ── dual-dialect-appliers (stage 10) ──────────────────────────────────────────────────────────
  {
    job: 'dual-dialect-appliers',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'dual-dialect-appliers',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'dual-dialect-appliers',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'dual-dialect-appliers',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'dual-dialect-appliers', key: 'pnpm test:appliers', mode: 'run', tier: 'full' },

  // ── chaos-harness (stage 11) ──────────────────────────────────────────────────────────────────
  {
    job: 'chaos-harness',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '6ed9be03e935',
  },
  {
    job: 'chaos-harness',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'chaos-harness',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'chaos-harness',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  { job: 'chaos-harness', key: 'pnpm chaos', mode: 'run', tier: 'full' },

  // ── security-sweep (stage 13) — RED BY DESIGN, and that red is why the rest went unread ───────
  {
    job: 'security-sweep',
    key: 'uses actions/checkout@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '05d4b205fa44',
  },
  {
    job: 'security-sweep',
    key: 'corepack enable',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '21fe765812d3',
  },
  {
    job: 'security-sweep',
    key: 'uses actions/setup-node@v4',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '5fdd943008f1',
  },
  {
    job: 'security-sweep',
    key: 'pnpm install --frozen-lockfile',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '96929d7007ed',
  },
  {
    job: 'security-sweep',
    key: 'install gitleaks (checksum-pinned)',
    mode: 'skip',
    why: 'RUNNER_PROVISIONING',
    body: '22550cdd57c0',
  },
  {
    job: 'security-sweep',
    key: 'security sweep (SEC inventory + SEC-TENANT-04 walk + secrets + dependency audit)',
    mode: 'run',
    tier: 'full',
    expect: 'SEC_OWED_D21',
  },
];

// ── Expected reds: OWED (a decision, by design) vs everything else (UNEXPECTED) ───────────────────

/**
 * Deliverable 3 of task 142. `security-sweep` has been red since it landed and always will be until
 * two SEC ids are discharged — and THAT PERMANENT RED IS WHY THE OTHER FOUR FAILURES WENT UNREAD FOR
 * A DAY. A gate that is always red teaches people to stop reading the run. So the ONE genuinely
 * permanent red is labelled and set apart from every regression.
 *
 * THERE IS EXACTLY ONE EXEMPTION CATEGORY, AND THAT IS DELIBERATE.
 * An exemption is only ever for a DECISION with no delivery date — here D21's SEC allowlist, whose
 * proof needs hardware CI/Node does not have. Everything else that reds is UNEXPECTED and must be
 * read. A merely "known" bug does NOT get its own quiet lane: a bug is exactly what a gate is FOR,
 * and the moment it is fixed any exemption for it becomes a liability. This file learned that on its
 * own first draft — it shipped a `CHAOS_05_TASK_127` "known-red" entry for a real chaos-05 defect;
 * task 127 then LANDED, chaos-05 went green, and the entry was instantly a STALE EXEMPTION excusing a
 * failure that no longer existed. A now-fixed failure recurring is a REGRESSION (UNEXPECTED), never a
 * standing exemption (CLAUDE.md §2.11: do not hard-code a fixed failure as owned). So the middle
 * category was removed by construction, and only `owed` remains.
 *
 * An owed entry is still not a mute button. It must ASSERT ITS OWN SCOPE (§2.11 — a guard asserts its
 * own coverage):
 *   * the step is expected to fail, and `assert()` confirms it failed for the RECORDED reason — a
 *     DIFFERENT failure inside the same step is UNEXPECTED and reds the run;
 *   * if the step PASSES, the entry is a STALE EXEMPTION and reds the run, so an exemption cannot
 *     outlive the thing it excused. (This is what would have caught the chaos-05 mistake above the
 *     moment 127 landed, had it not been removed outright — and it still guards SEC: the day
 *     SEC-AUTH-09/10 are discharged, sec:sweep goes green and this entry reds itself as stale.)
 *
 * `kind` is `'owed'` — a DECISION with no delivery date. Reported in its own block; it does NOT fail
 * the run, because a command that can never be green is a command nobody runs.
 */
export const EXPECTED = {
  SEC_OWED_D21: {
    kind: 'owed',
    ids: ['SEC-AUTH-09', 'SEC-AUTH-10'],
    owner:
      'tasks 27 / 27a / 28, per ai-docs/decisions/2026-07-22-assume-device-performance-passes.md (D21)',
    note: 'SEC-AUTH-09 leg 1 needs real SQLCipher (emulator lane only); SEC-AUTH-10 needs a physical-device benchmark artifact. Neither can be produced in Node. The pending allowlist is non-empty by design.',
    /**
     * The sweep prints an `EXIT=<n>  <step>` roll-up. The owed reds must be confined to the SEC
     * INVENTORY step: any OTHER failing sweep step (secrets scan, dependency audit, a test lane, the
     * frozen-lockfile check) is a real regression wearing the exemption's coat.
     * @param {string} output
     */
    assert(output) {
      const summary = output.slice(output.lastIndexOf('═══ sec:sweep summary ═══'));
      const failing = [...summary.matchAll(/^ {2}EXIT=([1-9]\d*)\s{2}(.+)$/gm)].map((m) =>
        m[2].trim(),
      );
      if (failing.length === 0) {
        return {
          ok: false,
          detail:
            'sec:sweep failed but its summary lists no failing step — the exemption cannot confirm WHY it is red',
        };
      }
      const allowed = failing.filter((name) => name.startsWith('SEC inventory'));
      const other = failing.filter((name) => !name.startsWith('SEC inventory'));
      if (other.length > 0) {
        return {
          ok: false,
          detail: `sec:sweep failed on step(s) OUTSIDE the owed SEC inventory: ${other.join(' · ')}`,
        };
      }
      const owed = ['SEC-AUTH-09', 'SEC-AUTH-10'].filter((id) => output.includes(id));
      if (owed.length === 0) {
        return {
          ok: false,
          detail:
            'the SEC inventory is red but names neither SEC-AUTH-09 nor SEC-AUTH-10 — a different id is owed than the one recorded here',
        };
      }
      return {
        ok: true,
        detail: `only ${allowed.join(' · ')} is red; owed ids present: ${owed.join(', ')}`,
      };
    },
  },
};

// ── The audit ────────────────────────────────────────────────────────────────────────────────────

/**
 * Prove the decision set is TOTAL against the workflow — the drift gate's whole content.
 *
 * @param {ReturnType<typeof parseWorkflow>} workflow
 * @param {typeof STEP_POLICY} [policy]
 */
export function auditParity(workflow, policy = STEP_POLICY) {
  const failures = [];
  const jobs = pushTriggeredJobs(workflow);

  /** @type {Map<string, {job: string, step: any}>} */
  const ciSteps = new Map();
  for (const job of jobs) {
    for (const step of job.steps) {
      const id = `${job.id}\x00${stepKey(step)}`;
      if (ciSteps.has(id)) {
        failures.push(
          `ci.yml job "${job.id}" has two steps identified as "${stepKey(step)}" — give one a distinct \`name:\``,
        );
      }
      ciSteps.set(id, { job: job.id, step });
    }
  }

  /** @type {Map<string, typeof STEP_POLICY[number]>} */
  const byId = new Map();
  for (const entry of policy) {
    const id = `${entry.job}\x00${entry.key}`;
    if (byId.has(id)) failures.push(`STEP_POLICY has two entries for ${entry.job} / ${entry.key}`);
    byId.set(id, entry);
    if (entry.mode !== 'run' && entry.mode !== 'skip') {
      failures.push(
        `STEP_POLICY ${entry.job} / ${entry.key}: mode must be 'run' or 'skip', got ${JSON.stringify(entry.mode)}`,
      );
    }
    if (entry.mode === 'run' && !TIERS.includes(entry.tier)) {
      failures.push(
        `STEP_POLICY ${entry.job} / ${entry.key}: a 'run' entry needs tier ${TIERS.join('|')}, got ${JSON.stringify(entry.tier)}`,
      );
    }
    if (entry.mode === 'skip' && SKIP_REASONS[entry.why] === undefined) {
      failures.push(
        `STEP_POLICY ${entry.job} / ${entry.key}: skip reason ${JSON.stringify(entry.why)} is not a SKIP_REASONS category`,
      );
    }
    if (entry.expect !== undefined && EXPECTED[entry.expect] === undefined) {
      failures.push(
        `STEP_POLICY ${entry.job} / ${entry.key}: expect ${JSON.stringify(entry.expect)} has no EXPECTED entry`,
      );
    }
  }

  // (1) UNCOVERED — a push-triggered CI step nothing local accounts for. THE defect of task 142.
  for (const [id, { job, step }] of ciSteps) {
    if (byId.has(id)) continue;
    failures.push(
      `UNCOVERED: ci.yml job "${job}" runs a step "${stepKey(step)}" that STEP_POLICY does not mention. ` +
        `Add {job:'${job}', key:${JSON.stringify(stepKey(step))}, mode:'run', tier:'fast'|'full'} — or mode:'skip' with a SKIP_REASONS category and body:'${fingerprint(step.body)}'.`,
    );
  }

  // (2) ORPHANED — local claims to mirror a step CI no longer has. Coverage that reads as real.
  for (const [id, entry] of byId) {
    if (ciSteps.has(id)) continue;
    failures.push(
      `ORPHANED: STEP_POLICY covers "${entry.job} / ${entry.key}", which is not a push-triggered step in ci.yml any more (renamed, moved, deleted, or gated behind an \`if:\`). Delete the entry or fix the key.`,
    );
  }

  // (3) STALE SKIP — a skipped step's body changed, so the recorded reason may have stopped holding.
  for (const [id, entry] of byId) {
    const found = ciSteps.get(id);
    if (found === undefined || entry.mode !== 'skip') continue;
    const current = fingerprint(found.step.body);
    if (entry.body !== current) {
      failures.push(
        `STALE SKIP: "${entry.job} / ${entry.key}" is skipped locally as ${entry.why}, but its ci.yml body changed (${entry.body} -> ${current}). Re-read the step, confirm the reason still holds, then update body to '${current}'.`,
      );
    }
  }

  const runEntries = policy.filter((entry) => entry.mode === 'run');
  return {
    ok: failures.length === 0,
    failures,
    checked: {
      pushJobs: jobs.map((job) => job.id),
      dispatchOnlyJobs: dispatchOnlyJobs(workflow).map((job) => job.id),
      ciSteps: ciSteps.size,
      policyEntries: policy.length,
      run: runEntries.length,
      fast: runEntries.filter((entry) => entry.tier === 'fast').length,
      full: runEntries.filter((entry) => entry.tier === 'full').length,
      skipped: policy.filter((entry) => entry.mode === 'skip').length,
    },
  };
}

/** Read + parse the checked-in workflow. */
export function loadWorkflow(path = WORKFLOW_PATH) {
  return parseWorkflow(readFileSync(path, 'utf8'));
}

/**
 * The ordered execution plan for a tier: every `run` entry, in ci.yml order, carrying the step's
 * VERBATIM `run:` text. The fast tier also reports what it is deferring — see scripts/verify.mjs.
 * @param {ReturnType<typeof parseWorkflow>} workflow
 * @param {'fast'|'full'} tier
 */
export function executionPlan(workflow, tier) {
  const byId = new Map(STEP_POLICY.map((entry) => [`${entry.job}\x00${entry.key}`, entry]));
  const included = [];
  const deferred = [];
  for (const job of pushTriggeredJobs(workflow)) {
    for (const step of job.steps) {
      const entry = byId.get(`${job.id}\x00${stepKey(step)}`);
      if (entry === undefined || entry.mode !== 'run') continue;
      const item = {
        job: job.id,
        key: stepKey(step),
        tier: entry.tier,
        command: step.run,
        expect: entry.expect,
      };
      if (item.command === undefined) {
        throw new Error(
          `ci-parity: ${job.id} / ${item.key} is mode:'run' but has no \`run:\` text`,
        );
      }
      if (tier === 'full' || entry.tier === 'fast') included.push(item);
      else deferred.push(item);
    }
  }
  return { included, deferred };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const workflow = loadWorkflow();
  const result = auditParity(workflow);
  console.log(
    `ci-parity: ${workflow.stats.jobs} jobs / ${workflow.stats.steps} steps parsed from ci.yml; ` +
      `${result.checked.pushJobs.length} push-triggered job(s) contributing ${result.checked.ciSteps} step(s); ` +
      `${result.checked.run} run locally (${result.checked.fast} fast + ${result.checked.full} full), ${result.checked.skipped} skipped.`,
  );
  console.log(
    `ci-parity: dispatch-only lanes NOT covered by any local command: ${result.checked.dispatchOnlyJobs.join(', ') || 'none'}.`,
  );
  for (const failure of result.failures) console.error(`ci-parity: FAIL ${failure}`);
  process.exit(result.ok ? 0 : 1);
}
