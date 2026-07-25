// TASK 172 — `pnpm ci:status` must decide OWED by running the SAME oracle `pnpm verify` uses against
// the failing job's OWN log, not by the job NAME alone.
//
// WHY THIS TEST EXISTS
// --------------------
// Before task 172, ci:status classified a red `security-sweep` job OWED purely because its name
// carried an `expect` entry — `EXPECTED[...].assert()` was never called. A `security-sweep` red for
// a BRAND-NEW reason (a secrets-scan failure, a new SEC id, a frozen-lockfile break, a test lane)
// still printed OWED and exited 0, hiding a regression behind the permanent SEC red — the exact
// defect task 142 existed to kill, surviving in the command 142 shipped. This file pins the closed
// hole: the seam `classifyExpectedRed` fetches the log, strips gh's runner column, and runs the real
// `EXPECTED.SEC_OWED_D21.assert()` — so ci:status and `pnpm verify` cannot disagree.
//
// THE ORACLE HERE IS THE REAL ONE, NOT A STUB (T-13: interrogate the oracle).
// The tests import `EXPECTED` from ci-parity.mjs and pass `EXPECTED.SEC_OWED_D21` straight into
// `classifyExpectedRed`. A stub oracle would prove the wiring and nothing about agreement with
// `pnpm verify`. Only the log FETCH is injected — so no live `gh` is called — and every "could not
// look" path (no log, 404, empty, truncated) is asserted LOUD (owed:false), never a silent OWED.
//
// FIXTURE PROVENANCE (T-15/T-16 — a fixture nobody has traced to a producer is a hypothesis).
// `ghLog()` reproduces the exact `gh run view --log-failed` framing observed on 2026-07-25: GitHub
// Actions run 30158848765, job 89680751269 (`security-sweep`) on d5321ad — each line is
// `<job>\t<step>\t<ISO timestamp> <content>`, with a BOM before the timestamp on the group's first
// line. `rawSweep()` is that run's sec:sweep body (SEC-AUTH-09 already discharged, so the live red
// names SEC-AUTH-10 alone), parameterised; every other case is that text with ONE stated mutation.
import { expect, test } from 'vitest';

// @ts-expect-error — plain .mjs script without type declarations (mirrors ci-parity.test.ts).
import * as ciParity from '../../../scripts/ci-parity.mjs';
// @ts-expect-error — plain .mjs script without type declarations.
import * as ciStatus from '../../../scripts/ci-status.mjs';

interface ExpectedEntry {
  kind: 'owed';
  ids: string[];
  owner: string;
  note: string;
  assert(output: string): { ok: boolean; detail: string };
}
type FetchResult = { ok: true; text: string } | { ok: false; reason: string };

const EXPECTED = ciParity.EXPECTED as Record<string, ExpectedEntry>;
const stripGhLogPrefix = ciStatus.stripGhLogPrefix as (logText: string) => string;
const classifyExpectedRed = ciStatus.classifyExpectedRed as (
  expected: ExpectedEntry,
  fetchLog: () => FetchResult,
) => { owed: boolean; detail: string };

/** The owed exemption, looked up by name and failing loudly if it is gone (mirrors ci-parity.test). */
function owed(): ExpectedEntry {
  const entry = EXPECTED.SEC_OWED_D21;
  if (entry === undefined) {
    throw new Error('EXPECTED.SEC_OWED_D21 no longer exists — the owed-red set has lost its entry');
  }
  return entry;
}

const JOB = 'security-sweep';
const STEP = 'security sweep (SEC inventory + SEC-TENANT-04 walk + secrets + dependency audit)';

/** Wrap raw sec:sweep content in `gh run view --log-failed` framing (BOM on the first line). */
function ghLog(rawLines: string[]): string {
  return rawLines
    .map((line, i) => {
      const ts = `2026-07-25T13:10:${String(10 + (i % 50)).padStart(2, '0')}.${1000000 + i}Z`;
      const bom = i === 0 ? '\uFEFF' : '';
      return `${JOB}\t${STEP}\t${bom}${ts} ${line}`;
    })
    .join('\n');
}

/** The real run's sec:sweep body, stripped, with the inventory FAIL lines and secrets-scan exit parameterised. */
function rawSweep(options: { fails?: string[]; secretsExit?: number } = {}): string[] {
  const {
    fails = [
      'FAIL the SEC pending allowlist is NOT empty — the release gate cannot pass while ids are owed: SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md',
    ],
    secretsExit = 0,
  } = options;
  return [
    '##[group]Run pnpm sec:sweep',
    '',
    '── build (tsc -b) — EXIT=0',
    '',
    '── test lane: repo suite (all vitest projects: unit, core, schemas, server, db-server, harness, i18n, ui) — EXIT=0',
    '',
    '── test lane: security-sweep lane (SEC-TENANT-04, SEC-SECRET-01, I-13) — EXIT=0',
    '',
    '── SEC inventory (security-guide §2.1.4 / §12) — EXIT=1',
    '58 ids parsed from the guide; 58 declared by the §12 roll-up.',
    '4037 test assertions read from 2 lane report(s); 57 ids have >=1 PASSING test.',
    ...fails,
    '',
    `── secrets scan (security-guide §10) — EXIT=${secretsExit}`,
    'gitleaks 8.30.1; working tree + full git history.',
    '',
    '── dependency pin / lockfile audit (08 §2, security-guide §11) — EXIT=0',
    '',
    '── lockfile in sync (pnpm install --frozen-lockfile) — EXIT=0',
    '',
    '═══ sec:sweep summary ═══',
    '  EXIT=0  build (tsc -b)',
    '  EXIT=0  test lane: repo suite (all vitest projects: unit, core, schemas, server, db-server, harness, i18n, ui)',
    '  EXIT=0  test lane: security-sweep lane (SEC-TENANT-04, SEC-SECRET-01, I-13)',
    '  EXIT=1  SEC inventory (security-guide §2.1.4 / §12)',
    `  EXIT=${secretsExit}  secrets scan (security-guide §10)`,
    '  EXIT=0  dependency pin / lockfile audit (08 §2, security-guide §11)',
    '  EXIT=0  lockfile in sync (pnpm install --frozen-lockfile)',
    '',
    'sec:sweep: 1 step(s) failed — the release gate is RED.',
    '##[error]Process completed with exit code 1.',
  ];
}

const fetchOk =
  (rawLines: string[]): (() => FetchResult) =>
  () => ({ ok: true, text: ghLog(rawLines) });

// ── 1. the positive control: the genuine current red stays OWED ──────────────────────────────────

test('the genuine security-sweep red (only SEC-AUTH-10) is OWED, and the detail cites the id', () => {
  // The MORE IMPORTANT half of this task: if the log assert turns today's legitimate owed-red into
  // UNEXPECTED, ci:status reds on every push and gets ignored — worse than the hole it closes.
  const verdict = classifyExpectedRed(owed(), fetchOk(rawSweep()));
  expect(verdict.owed).toBe(true);
  expect(verdict.detail).toContain('SEC-AUTH-10');
});

// ── 2. the hole task 172 closes: a security-sweep red for a NEW reason is UNEXPECTED ─────────────

test('a red OUTSIDE the SEC inventory (secrets scan) is NOT owed and names the offending step', () => {
  // The exact BEFORE/AFTER of the task: a security-sweep red whose failing step is not the SEC
  // inventory. Name-only classification called this OWED; the log assert calls it UNEXPECTED.
  const verdict = classifyExpectedRed(owed(), fetchOk(rawSweep({ secretsExit: 1 })));
  expect(verdict.owed).toBe(false);
  expect(verdict.detail).toContain('secrets scan');
});

test('a NEW SEC id inside the inventory step is NOT owed and names the intruding id', () => {
  const verdict = classifyExpectedRed(
    owed(),
    fetchOk(
      rawSweep({
        fails: [
          'FAIL SEC-META-01 has no PASSING test in any swept lane (titles seen: none)',
          'FAIL the SEC pending allowlist is NOT empty — the release gate cannot pass while ids are owed: SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md',
        ],
      }),
    ),
  );
  expect(verdict.owed).toBe(false);
  expect(verdict.detail).toContain('SEC-META-01');
});

// ── 3. every "could not look" path is LOUD (owed:false), never a silent OWED (task 154) ──────────

test.each<[string, () => FetchResult, string]>([
  [
    'the log fetch failed outright (gh missing / network)',
    () => ({ ok: false, reason: 'gh could not run: spawn gh ENOENT' }),
    'could NOT read',
  ],
  [
    'the job id 404s',
    () => ({
      ok: false,
      reason: 'gh run view --log-failed --job 999 EXIT=1: could not find any run for job 999',
    }),
    'could NOT read',
  ],
  ['the log came back empty', () => ({ ok: true, text: '' }), 'came back EMPTY'],
  [
    'the log is truncated before the summary',
    () => ({ ok: true, text: ghLog(rawSweep().slice(0, 12)) }),
    'printed no "═══ sec:sweep summary ═══"',
  ],
])('a red carrying an exemption is UNEXPECTED when %s', (_name, fetchLog, expectedDetail) => {
  const verdict = classifyExpectedRed(owed(), fetchLog);
  expect(verdict.owed).toBe(false);
  expect(verdict.detail).toContain(expectedDetail);
});

// ── 4. the strip is what lets the two commands share one oracle ──────────────────────────────────

test('stripGhLogPrefix removes gh’s runner column and preserves the sweep’s own bytes', () => {
  const stripped = stripGhLogPrefix(ghLog(rawSweep()));
  // The job/step/timestamp column is gone…
  expect(stripped).not.toContain(`${JOB}\t${STEP}\t`);
  expect(stripped).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // …and the content the oracle reads is intact AT LINE START (the summary marker, the two-space
  // EXIT lines, the em dash + arrow the FAIL line carries).
  expect(`\n${stripped}`).toContain('\n═══ sec:sweep summary ═══');
  expect(stripped).toContain('\n  EXIT=1  SEC inventory');
  expect(stripped).toContain('SEC-AUTH-10 → ai-docs');
  // And after stripping, the real oracle reaches its OWED verdict on this exact text — proving the
  // strip produces what `EXPECTED.assert()` (and thus `pnpm verify`) consumes.
  expect(owed().assert(stripped).ok).toBe(true);
});

test('a log left UNSTRIPPED does NOT read as owed — the strip is load-bearing, and its absence fails closed', () => {
  // If gh's framing ever changed so the prefix survived, the oracle must NOT be fooled into OWED.
  const withPrefix = ghLog(rawSweep());
  expect(owed().assert(withPrefix).ok).toBe(false);
});
