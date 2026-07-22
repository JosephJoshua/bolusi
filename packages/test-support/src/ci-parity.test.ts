// THE DRIFT GATE (task 142). Fails when `.github/workflows/ci.yml` gains, loses, or renames a
// push-triggered step that `pnpm verify` does not account for.
//
// WHY THIS IS THE LOAD-BEARING HALF
// ---------------------------------
// A local "run what CI runs" command is worth nothing on its own: it is correct the day it is
// written and wrong the first time someone adds a step to ci.yml. That is not hypothetical — it is
// exactly what happened. CI's `lint` job grew `pnpm i18n:check`; every local run kept executing
// `pnpm lint`; `main` was red for over a day while every gate anyone read said green.
//
// So this test does not check that `pnpm verify` works. It checks that the DECISION SET is TOTAL
// against the workflow, in BOTH directions, and it runs inside the `unit` job — i.e. CI itself
// refuses a workflow change that the local command has not been taught.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE EXISTS (T-12: test the class, not the instance)
// ------------------------------------------------------------------------------------
// The parser is the part that can go blind and report a confident zero — CLAUDE.md §2.11 lists five
// shipped gates that were green for exactly that reason, and one of them was a sweep that looped
// over a parse checking ZERO properties. A totality check over an empty parse is vacuously perfect.
// So the cases below are, in order: the real workflow is covered; the audit CAN fail (four distinct
// ways, each provoked); and the parser REFUSES a degraded parse rather than shrinking quietly. The
// mutation cases operate on the REAL ci.yml text, so they cannot drift from it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

// @ts-expect-error — plain .mjs script without type declarations (mirrors task-status.test.ts).
import * as ciParity from '../../../scripts/ci-parity.mjs';

// ── the .mjs module's shape, declared once (mirrors test-script-builds.test.ts) ──────────────────

interface WorkflowStep {
  index: number;
  name?: string;
  uses?: string;
  run?: string;
  body: string;
}
interface WorkflowJob {
  id: string;
  if?: string;
  steps: WorkflowStep[];
}
interface Workflow {
  jobs: WorkflowJob[];
  stats: { jobs: number; steps: number; rawJobKeys: number; rawStepDashes: number };
}
interface PolicyEntry {
  job: string;
  key: string;
  mode: 'run' | 'skip';
  tier?: 'fast' | 'full';
  why?: string;
  body?: string;
  expect?: string;
}
interface PlanItem {
  job: string;
  key: string;
  tier: 'fast' | 'full';
  command: string;
  expect?: string;
}
interface AuditResult {
  ok: boolean;
  failures: string[];
  checked: {
    pushJobs: string[];
    dispatchOnlyJobs: string[];
    ciSteps: number;
    policyEntries: number;
    run: number;
    fast: number;
    full: number;
    skipped: number;
  };
}
interface ExpectedEntry {
  kind: 'owed';
  ids: string[];
  owner: string;
  note: string;
  assert(output: string): { ok: boolean; detail: string };
}

const parseWorkflow = ciParity.parseWorkflow as (text: string) => Workflow;
const auditParity = ciParity.auditParity as (
  workflow: Workflow,
  policy?: PolicyEntry[],
) => AuditResult;
const executionPlan = ciParity.executionPlan as (
  workflow: Workflow,
  tier: 'fast' | 'full',
) => { included: PlanItem[]; deferred: PlanItem[] };
const dispatchOnlyJobs = ciParity.dispatchOnlyJobs as (workflow: Workflow) => WorkflowJob[];
const evaluateEventGate = ciParity.evaluateEventGate as (
  expression: string,
  eventName: string,
) => boolean;
const STEP_POLICY = ciParity.STEP_POLICY as PolicyEntry[];
const EXPECTED = ciParity.EXPECTED as Record<string, ExpectedEntry>;

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');

function audit(text: string = workflowText, policy?: PolicyEntry[]): AuditResult {
  return auditParity(parseWorkflow(text), policy);
}

/**
 * Look an expected-red entry up BY NAME and fail loudly if it is gone. A test that silently skipped
 * a deleted exemption would be the very "green because it checked nothing" shape this file guards.
 */
function expected(name: string): ExpectedEntry {
  const entry = EXPECTED[name];
  if (entry === undefined) {
    throw new Error(`EXPECTED.${name} no longer exists — the owed-red set has lost an entry`);
  }
  return entry;
}

// ── 1. the checked-in workflow is fully covered ─────────────────────────────────────────────────

test('every push-triggered ci.yml step is accounted for by STEP_POLICY', () => {
  const result = audit();
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
});

test('the parse is not blind: it walks every job key and step dash in the file', () => {
  const parsed = parseWorkflow(workflowText);
  // Independent of the state machine — a raw regex count over the same text.
  const jobsRegion = workflowText.slice(workflowText.indexOf('\njobs:\n'));
  const rawJobs = jobsRegion
    .split('\n')
    .filter((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)).length;
  const rawSteps = jobsRegion.split('\n').filter((line) => /^ {6}- /.test(line)).length;
  expect(parsed.stats.jobs).toBe(rawJobs);
  expect(parsed.stats.steps).toBe(rawSteps);
  // The denominator itself, so a workflow that shrank to nothing cannot pass the two equalities.
  expect(parsed.stats.jobs).toBeGreaterThanOrEqual(15);
  expect(parsed.stats.steps).toBeGreaterThanOrEqual(80);
});

test('the three CI steps whose invisibility caused the outage are in the executed plan, by name', () => {
  // T-16: a mention is not a producer. These assert the SPECIFIC steps that were invisible on
  // 2026-07-21 are executed, not merely that the jobs exist.
  const plan = executionPlan(parseWorkflow(workflowText), 'full');
  const executed = plan.included.map((item) => `${item.job} / ${item.key}`);
  expect(executed).toContain('lint / pnpm i18n:check');
  expect(executed).toContain('db-client / client codegen types are up to date (10-db §11.4)');
  expect(executed).toContain('unit / pnpm test');
  // ...and each carries the workflow's OWN command text, not a transcription of it.
  expect(plan.included.find((item) => item.key === 'pnpm i18n:check')?.command).toBe(
    'pnpm i18n:check',
  );
  expect(
    plan.included.find((item) => item.key.startsWith('client codegen types'))?.command,
  ).toContain('git diff --exit-code -- packages/db-client/src/generated');
});

// ── 2. the audit CAN fail — one provocation per failure mode ────────────────────────────────────

test('a NEW ci.yml step that no policy entry covers fails the audit (UNCOVERED)', () => {
  // The 2026-07-21 outage, re-enacted: the `lint` job grows a second command.
  const mutated = workflowText.replace(
    '      - run: pnpm i18n:check\n',
    '      - run: pnpm i18n:check\n      - run: pnpm some-new-gate\n',
  );
  expect(mutated).not.toBe(workflowText);
  const result = audit(mutated);
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain('UNCOVERED');
  expect(result.failures.join('\n')).toContain('pnpm some-new-gate');
});

test('dropping a step from the local command leaves its ci.yml step UNCOVERED', () => {
  const trimmed = STEP_POLICY.filter(
    (entry) => !(entry.job === 'lint' && entry.key === 'pnpm i18n:check'),
  );
  expect(trimmed.length).toBe(STEP_POLICY.length - 1);
  const result = audit(workflowText, trimmed);
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain('UNCOVERED');
  expect(result.failures.join('\n')).toContain('pnpm i18n:check');
});

test('a policy entry for a step ci.yml no longer has fails the audit (ORPHANED)', () => {
  const invented: PolicyEntry[] = [
    ...STEP_POLICY,
    { job: 'lint', key: 'pnpm a-gate-ci-does-not-run', mode: 'run', tier: 'fast' },
  ];
  const result = audit(workflowText, invented);
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toContain('ORPHANED');
  expect(result.failures.join('\n')).toContain('pnpm a-gate-ci-does-not-run');
});

test('editing a step that is SKIPPED locally fails the audit', () => {
  // A skipped step's body is not executed, so its recorded reason is a claim nobody re-reads.
  const mutated = workflowText.replace(
    '      - run: corepack enable\n',
    '      - run: corepack enable --some-new-flag\n',
  );
  expect(mutated).not.toBe(workflowText);
  const result = audit(mutated);
  expect(result.ok).toBe(false);
  expect(result.failures.join('\n')).toMatch(/STALE SKIP|UNCOVERED/);
});

test('a job moved behind a dispatch-only `if:` stops being claimed as locally covered', () => {
  const mutated = workflowText.replace(
    '  lint:\n    runs-on: ubuntu-latest\n',
    "  lint:\n    runs-on: ubuntu-latest\n    if: github.event_name == 'schedule'\n",
  );
  expect(mutated).not.toBe(workflowText);
  const result = audit(mutated);
  expect(result.ok).toBe(false);
  // Every `lint` entry is now orphaned: the local command must not imply it covers a lane a push
  // never starts.
  expect(
    result.failures.filter((failure) => failure.startsWith('ORPHANED')).length,
  ).toBeGreaterThanOrEqual(6);
});

// ── 3. the parser refuses a degraded parse rather than shrinking quietly ─────────────────────────

test('a truncated workflow throws instead of reporting a small, clean parse', () => {
  const truncated = workflowText.slice(0, workflowText.indexOf('  typecheck:'));
  expect(() => parseWorkflow(truncated)).toThrow(/floor|incomplete|ZERO steps/);
});

test('a step with neither `run:` nor `uses:` throws', () => {
  const mutated = workflowText.replace(
    '      - run: pnpm lint\n',
    '      - name: a step that does nothing\n',
  );
  expect(mutated).not.toBe(workflowText);
  expect(() => parseWorkflow(mutated)).toThrow(/neither `run:` nor `uses:`/);
});

test('an `if:` expression the evaluator does not understand throws rather than assuming it runs', () => {
  expect(() => evaluateEventGate("github.ref == 'refs/heads/main'", 'push')).toThrow(
    /unsupported job `if:` expression/,
  );
  // The shapes it DOES understand, both directions.
  expect(evaluateEventGate("github.event_name == 'schedule'", 'push')).toBe(false);
  expect(
    evaluateEventGate(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
      'schedule',
    ),
  ).toBe(true);
});

// ── 4. the tier split and the expected-red table are self-describing ─────────────────────────────

test('the native lanes are classified dispatch-only and are NOT in any local plan', () => {
  const workflow = parseWorkflow(workflowText);
  const dispatchOnly = dispatchOnlyJobs(workflow).map((job) => job.id);
  expect(dispatchOnly).toEqual(['android-emulator', 'ios-simulator']);
  for (const item of executionPlan(workflow, 'full').included) {
    expect(dispatchOnly).not.toContain(item.job);
  }
});

test('the fast tier is a strict subset of the full tier, and the full tier is every run entry', () => {
  const workflow = parseWorkflow(workflowText);
  const fast = executionPlan(workflow, 'fast');
  const full = executionPlan(workflow, 'full');
  const fastKeys = fast.included.map((item) => `${item.job} / ${item.key}`);
  const fullKeys = full.included.map((item) => `${item.job} / ${item.key}`);
  expect(full.deferred).toEqual([]);
  expect(fullKeys.length).toBe(STEP_POLICY.filter((entry) => entry.mode === 'run').length);
  for (const key of fastKeys) expect(fullKeys).toContain(key);
  // The fast tier MUST have something to announce — an empty deferred list would mean the "not run
  // by this tier" block prints nothing while steps are still missing.
  expect(fast.deferred.length).toBeGreaterThan(0);
  expect(fastKeys.length + fast.deferred.length).toBe(fullKeys.length);
});

test('OWED is the ONLY exemption kind, and every entry asserts its own scope', () => {
  const referenced = new Set(
    STEP_POLICY.filter((entry) => entry.expect !== undefined).map((entry) => entry.expect),
  );
  expect(referenced.size).toBeGreaterThan(0);
  for (const [name, entry] of Object.entries(EXPECTED)) {
    expect(referenced, `EXPECTED.${name} is not referenced by any STEP_POLICY entry`).toContain(
      name,
    );
    // There is exactly one exemption category. A now-fixed defect (chaos-05/task 127) must NOT be
    // reintroduced as a standing 'known' exemption — a recurrence is an UNEXPECTED regression.
    expect(entry.kind).toBe('owed');
    expect(entry.ids.length).toBeGreaterThan(0);
    expect(entry.owner).toBeTruthy();
    expect(typeof entry.assert).toBe('function');
    // An exemption whose assert() accepts anything is a mute button, not a gate: feed it output
    // that does not describe its recorded failure and it must refuse.
    expect(entry.assert('some unrelated build failure\n').ok).toBe(false);
  }
});

test('no fixed-then-recurred defect is hard-coded as owned (chaos-05 / task 127 is not exempt)', () => {
  // The gate must classify a chaos-05 recurrence as a REGRESSION. Neither the `unit` nor the
  // `chaos-harness` step carries an `expect`, and no EXPECTED entry mentions CHAOS.
  const unitStep = STEP_POLICY.find((entry) => entry.job === 'unit' && entry.key === 'pnpm test');
  const chaosStep = STEP_POLICY.find(
    (entry) => entry.job === 'chaos-harness' && entry.key === 'pnpm chaos',
  );
  expect(unitStep?.expect).toBeUndefined();
  expect(chaosStep?.expect).toBeUndefined();
  for (const entry of Object.values(EXPECTED)) {
    expect(entry.ids.join(' ')).not.toContain('CHAOS');
  }
  expect(EXPECTED.CHAOS_05_TASK_127).toBeUndefined();
});

test('the owed SEC red is confined to the SEC inventory step', () => {
  const owed = expected('SEC_OWED_D21');
  const inventoryOnly = [
    '═══ sec:sweep summary ═══',
    '  EXIT=0  build (tsc -b)',
    '  EXIT=1  SEC inventory (security-guide §2.1.4 / §12)',
    '  EXIT=0  secrets scan (security-guide §10)',
    'FAIL SEC-AUTH-09 is pending',
  ].join('\n');
  expect(owed.assert(inventoryOnly).ok).toBe(true);
  // A secrets-scan regression must NOT be absorbed by the SEC exemption.
  const alsoSecrets = inventoryOnly.replace(
    '  EXIT=0  secrets scan (security-guide §10)',
    '  EXIT=1  secrets scan (security-guide §10)',
  );
  expect(owed.assert(alsoSecrets).ok).toBe(false);
  expect(owed.assert(alsoSecrets).detail).toContain('secrets scan');
});
