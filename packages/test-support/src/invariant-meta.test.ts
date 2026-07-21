// Invariant coverage gate (decision D15b): every LIVE invariant in `01-domain-model.md §10`
// ("Invariants (testable, numbered)") must have a verbatim-id test TITLE, or a pending-allowlist
// entry naming its (existing, not-done) owning task file. Invariants are CONTRACTS — a universally
// quantified claim in a section promising testability, with no test, fails by being ABSENT, and
// absence is invisible to every other test. (FR-#### ids are PROVENANCE and get no such gate — see
// the note in 01-domain-model.md §10 and decision D15a.)
//
// This rides the SAME machinery as SEC-META-01 (task 31's declarative-ownership rails), configured
// with INVARIANT_SCHEME — one implementation, two configs (CLAUDE.md §2.8), not a second gate.
//
// NOTE ON THE FAKE IDS BELOW (`I-91`, `I-913`) — this is not decoration. This file's own test
// titles are read by the very gate it tests: `collectTrackedTestFiles` walks every committed test
// file, so a title here naming a REAL invariant would satisfy that invariant's coverage from
// inside the meta-test, and a real id that is also allowlisted (I-13) would trip `titledButPending`.
// So every id in a title here is deliberately outside the live range I-1..I-13, exactly as
// sec-meta.test.ts uses SEC-FAKE-*. `I-91` is a textual prefix of `I-913`, which reproduces the
// I-1-inside-I-13 collision the boundary matcher exists to defeat, while claiming nothing real.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  auditInvariantCoverage,
  collectTrackedTaskFiles,
  collectTrackedTestFiles,
  extractTestTitles,
  liveInvariantIds,
  parseInvariants,
} from './sec-meta.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const LIVE_INVARIANTS = [
  'I-1',
  'I-2',
  'I-3',
  'I-4',
  'I-5',
  'I-6',
  'I-7',
  'I-8',
  'I-9',
  'I-10',
  'I-11',
  'I-13',
];

function loadAllowlist(): Record<string, string> {
  const allowlist: Record<string, string> = JSON.parse(
    readFileSync(new URL('./invariant-pending-allowlist.json', import.meta.url), 'utf8'),
  );
  delete allowlist['$comment'];
  return allowlist;
}

// A minimal §10 whose live set is exactly {I-91, I-913} — both outside the real range (see the
// file header). I-91 is a textual prefix of I-913, which is the whole reason the invariant scheme
// boundary-matches instead of using `includes`.
const FIXTURE_DOMAIN_MODEL = [
  '## 9. Something before',
  '',
  '## 10. Invariants (testable, numbered)',
  '',
  '| # | Invariant |',
  '| - | --------- |',
  '| I-91 | A fixture invariant. |',
  '| I-913 | A fixture invariant whose id has the first one as a prefix. |',
  '',
  '## 11. Out of v0',
  '',
  'a stray reference to I-91 down here must NOT be counted as an extra invariant.',
].join('\n');

// ── The real repo: every live invariant is owned ──────────────────────────────────────────────

test('every LIVE invariant in 01-domain-model section 10 has a verbatim test title or a pending-task allowlist entry', () => {
  const domainModelText = readFileSync(join(REPO_ROOT, 'ai-docs/01-domain-model.md'), 'utf8');
  const testFiles = collectTrackedTestFiles(REPO_ROOT);
  const testTitles = testFiles.flatMap((file) =>
    extractTestTitles(readFileSync(join(REPO_ROOT, file), 'utf8')),
  );
  const taskFiles = Object.fromEntries(
    collectTrackedTaskFiles(REPO_ROOT).map((path) => [
      path,
      readFileSync(join(REPO_ROOT, path), 'utf8'),
    ]),
  );

  const result = auditInvariantCoverage({
    domainModelText,
    allowlist: loadAllowlist(),
    testTitles,
    taskFiles,
  });

  // ORDER IS DELIBERATE, and was fixed by falsifying it. The named-content assertions come FIRST
  // so that dropping an invariant's title reds with `missing: ["I-3"]` — NAMING the invariant an
  // author has to go fix. With the denominator floors first, the same break reported only
  // "expected 10 to be 11", which says something is wrong but not WHICH invariant.
  //
  // This costs nothing in T-14 terms: the vacuous case (a parse that matched nothing) leaves every
  // array below trivially empty, so it sails through these and is caught by the floors after.
  expect(
    result.missing,
    'live invariants with neither a test title nor an allowlist entry',
  ).toEqual([]);
  expect(result.staleAllowlist, 'allowlist entries pointing at done tasks').toEqual([]);
  expect(result.badOwners, 'allowlist entries with invalid owning-task files').toEqual([]);
  expect(result.unknownEntries, 'allowlist entries not present in section 10').toEqual([]);
  expect(result.titledButPending, 'ids both titled by a test and allowlisted as owed').toEqual([]);
  expect(result.ownershipConflicts, 'ids declared by more than one task file').toEqual([]);
  expect(result.partialLegTitles, 'ids retired only by a self-declared partial-leg title').toEqual(
    [],
  );

  // T-14 — the gate states its own denominator and fails loudly on zero. 12 live invariants
  // (one is retired). A parse that silently matched nothing would report green for the wrong
  // reason — the failure this repo has shipped eight times.
  expect(result.checked.ids, 'LIVE invariants parsed from section 10 (retired excluded)').toBe(12);
  // 11 of the 12 are discharged by a titled test; the 12th is openly owed on the allowlist. If the
  // title walk silently found nothing, this floor goes red instead of every rule above passing
  // vacuously.
  expect(result.checked.idsWithTitles, 'live invariants with at least one verbatim title').toBe(11);
  expect(result.checked.titles, 'tracked test titles parsed').toBeGreaterThan(1000);
  expect(result.checked.taskFiles, 'tracked task files parsed').toBeGreaterThan(30);
  expect(testFiles.length, 'tracked test files walked').toBeGreaterThan(100);
});

// ── The denominator, asserted (T-14) — the count is derived, not taken on trust ───────────────

test('section 10 denominator: 13 numbered, exactly one retired, 12 live', () => {
  const domainModelText = readFileSync(join(REPO_ROOT, 'ai-docs/01-domain-model.md'), 'utf8');
  const rows = parseInvariants(domainModelText);

  expect(rows, '13 numbered invariants').toHaveLength(13);
  expect(
    rows.filter((row) => row.retired).map((row) => row.id),
    'exactly the twelfth is retired — confirmed against the row text, not assumed',
  ).toEqual(['I-12']);
  expect(liveInvariantIds(domainModelText), '12 live invariants, numeric order').toEqual(
    LIVE_INVARIANTS,
  );
});

test('a doc with no numbered-invariants section parses to ZERO invariants — the empty denominator the gate must reject', () => {
  // If the parse silently matches nothing, checked.ids is 0 and the real-repo test's `toBe(12)`
  // (and the floors) go red. A gate that silently checks zero is worse than no gate (T-14).
  expect(parseInvariants('# doc\n\n## 9. before\n\n## 11. after\n')).toEqual([]);
  const result = auditInvariantCoverage({
    domainModelText: 'no section here at all',
    allowlist: {},
    testTitles: [],
    taskFiles: {},
  });
  expect(result.checked.ids).toBe(0);
});

// ── The gate reds when an invariant is unowned (missing) ──────────────────────────────────────

test('a live invariant with no test title and no allowlist entry is reported missing', () => {
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: {},
    testTitles: [],
    taskFiles: {},
  });
  expect(result.missing).toEqual(['I-91', 'I-913']);
});

// ── Boundary matching: a shorter id is a substring of a longer one, and must not be satisfied ──

test('a title claiming the longer id does NOT satisfy the shorter id it textually contains', () => {
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: {},
    testTitles: ['I-913 the longer fixture invariant holds'],
    taskFiles: {},
  });
  // The longer id is titled; the shorter is NOT — a naive `includes` would wrongly retire it here.
  expect(result.missing).toEqual(['I-91']);
});

test('a title claiming the shorter id satisfies only the shorter id', () => {
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: {},
    testTitles: ['I-91 the shorter fixture invariant holds'],
    taskFiles: {},
  });
  expect(result.missing).toEqual(['I-913']);
});

// ── Declarative ownership rides task 31's rails: mention != ownership ──────────────────────────

test('an allowlist row whose owner file only MENTIONS the invariant fails the gate', () => {
  const mentioningTask = [
    '**Status:** todo',
    '',
    'This task discusses the invariant at length in its prose but never declares it on a marker.',
  ].join('\n');
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: {
      'I-91': 'ai-docs/tasks/05-db-server.md',
      'I-913': 'ai-docs/tasks/28-security-sweep.md',
    },
    testTitles: [],
    taskFiles: {
      'ai-docs/tasks/05-db-server.md': '**Status:** todo\nno marker here either',
      'ai-docs/tasks/28-security-sweep.md': mentioningTask,
    },
  });
  expect(result.badOwners).toEqual([
    'I-91 → ai-docs/tasks/05-db-server.md (no "Invariants owned by THIS task:" marker declares the id)',
    'I-913 → ai-docs/tasks/28-security-sweep.md (no "Invariants owned by THIS task:" marker declares the id)',
  ]);
});

test('a declared "Invariants owned by THIS task" marker makes the allowlist owner valid', () => {
  const owningTask = ['**Status:** todo', '**Invariants owned by THIS task:** I-913'].join('\n');
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: { 'I-913': 'ai-docs/tasks/28-security-sweep.md' },
    testTitles: ['I-91 the shorter fixture invariant holds'],
    taskFiles: { 'ai-docs/tasks/28-security-sweep.md': owningTask },
  });
  expect(result.badOwners).toEqual([]);
  expect(result.missing).toEqual([]);
});

test('a malformed ownership marker fails loudly instead of silently declaring nothing', () => {
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: { 'I-913': 'ai-docs/tasks/28-security-sweep.md' },
    testTitles: ['I-91 the shorter fixture invariant holds'],
    taskFiles: {
      'ai-docs/tasks/28-security-sweep.md': [
        '**Status:** todo',
        '**Invariants owned by THIS task:** I-913 and some prose the grammar forbids',
      ].join('\n'),
    },
  });
  expect(result.badOwners).toEqual([
    'I-913 → ai-docs/tasks/28-security-sweep.md (malformed "Invariants owned by THIS task:" marker: expected a comma-separated list of invariant ids/ranges or "none", got "I-913 and some prose the grammar forbids")',
  ]);
});

test('an invariant range declaration expands and does not spill past its bounds', () => {
  const rangeTask = ['**Status:** todo', '**Invariants owned by THIS task:** I-91..913'].join('\n');
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: {
      'I-91': 'ai-docs/tasks/05-db-server.md',
      'I-913': 'ai-docs/tasks/05-db-server.md',
    },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/05-db-server.md': rangeTask },
  });
  expect(result.badOwners).toEqual([]);
  expect(result.missing).toEqual([]);
});

// ── titledButPending: a title and a pending row cannot both be true (task 31's rail) ──────────

test('an invariant both titled by a test AND on the pending allowlist is a contradiction', () => {
  const owningTask = ['**Status:** todo', '**Invariants owned by THIS task:** I-913'].join('\n');
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: { 'I-913': 'ai-docs/tasks/28-security-sweep.md' },
    testTitles: [
      'I-913 the longer fixture invariant is fully scanned',
      'I-91 the shorter fixture invariant holds',
    ],
    taskFiles: { 'ai-docs/tasks/28-security-sweep.md': owningTask },
  });
  expect(result.titledButPending).toEqual([
    'I-913 → ai-docs/tasks/28-security-sweep.md (a test titles the id, but the row still says it is owed)',
  ]);
});

test('an allowlist entry whose owning task is done counts as stale', () => {
  const result = auditInvariantCoverage({
    domainModelText: FIXTURE_DOMAIN_MODEL,
    allowlist: { 'I-913': 'ai-docs/tasks/28-security-sweep.md' },
    testTitles: ['I-91 the shorter fixture invariant holds'],
    taskFiles: {
      'ai-docs/tasks/28-security-sweep.md':
        '**Status:** done\n**Invariants owned by THIS task:** I-913',
    },
  });
  expect(result.staleAllowlist).toEqual([
    'I-913 → ai-docs/tasks/28-security-sweep.md (task is done but the test never shipped)',
  ]);
});
