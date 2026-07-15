// SEC-META-01 (security-guide §2.1.4): mechanically enforce "tests ship with the surface".
// Real audit: every SEC id in security-guide.md needs a verbatim test TITLE in a committed
// test file, or a pending-allowlist entry naming its (existing, not-done) owning task file.
// Negative tests below prove the detection logic cannot be satisfied by comments, untracked
// files, or dangling allowlist entries.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  auditSecCoverage,
  collectTrackedTaskFiles,
  collectTrackedTestFiles,
  extractTestTitles,
} from './sec-meta.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function loadAllowlist(): Record<string, string> {
  const allowlist: Record<string, string> = JSON.parse(
    readFileSync(new URL('./sec-pending-allowlist.json', import.meta.url), 'utf8'),
  );
  delete allowlist['$comment'];
  return allowlist;
}

test('SEC-META-01 every security-guide SEC id has a verbatim test title or a pending-task allowlist entry', () => {
  const guideText = readFileSync(join(REPO_ROOT, 'ai-docs/security-guide.md'), 'utf8');
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

  const result = auditSecCoverage({
    guideText,
    allowlist: loadAllowlist(),
    testTitles,
    taskFiles,
  });

  // T-14 — the gate states its own denominator and fails loudly on zero. A sweep that
  // silently looked at nothing would report green for the wrong reason.
  expect(result.checked.ids, 'SEC ids parsed from security-guide.md').toBeGreaterThan(50);
  expect(result.checked.titles, 'tracked test titles parsed').toBeGreaterThan(1000);
  expect(result.checked.taskFiles, 'tracked task files parsed').toBeGreaterThan(30);
  expect(testFiles.length, 'tracked test files walked').toBeGreaterThan(100);

  expect(result.missing, 'SEC ids with neither a test title nor an allowlist entry').toEqual([]);
  expect(result.staleAllowlist, 'allowlist entries pointing at done tasks').toEqual([]);
  expect(result.badOwners, 'allowlist entries with invalid owning-task files').toEqual([]);
  expect(result.unknownEntries, 'allowlist entries not present in security-guide.md').toEqual([]);
  expect(result.titledButPending, 'ids both titled by a test and allowlisted as owed').toEqual([]);
  expect(result.ownershipConflicts, 'ids declared by more than one task file').toEqual([]);
});

test('a SEC id mentioned only in a comment or fixture string is NOT counted as tested', () => {
  const source = [
    '// SEC-FAKE-01 mentioned in a comment must not count',
    "const fixture = 'SEC-FAKE-01 in a plain string must not count';",
    "test('some unrelated behavior', () => {});",
  ].join('\n');
  const titles = extractTestTitles(source);
  expect(titles).toEqual(['some unrelated behavior']);

  const result = auditSecCoverage({
    guideText: 'requires SEC-FAKE-01',
    allowlist: {},
    testTitles: titles,
    taskFiles: {},
  });
  expect(result.missing).toEqual(['SEC-FAKE-01']);
});

test('title extraction covers test/it/describe with modifiers and template literals', () => {
  const source = [
    "it.only('SEC-FAKE-02 via it.only', () => {});",
    'describe(`SEC-FAKE-03 via template`, () => {});',
    'test.each([[1]])("SEC-FAKE-04 via each", () => {});',
  ].join('\n');
  expect(extractTestTitles(source)).toEqual([
    'SEC-FAKE-02 via it.only',
    'SEC-FAKE-03 via template',
    'SEC-FAKE-04 via each',
  ]);
});

test('untracked decoy test files are invisible to the committed-file walk', () => {
  const decoyPath = join(REPO_ROOT, 'packages/test-support/src/__decoy-untracked.test.ts');
  writeFileSync(decoyPath, "test('SEC-DECOY-99 planted title', () => {});\n");
  try {
    const tracked = collectTrackedTestFiles(REPO_ROOT);
    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked.some((file) => file.includes('__decoy-untracked'))).toBe(false);
  } finally {
    unlinkSync(decoyPath);
  }
});

test('allowlist entries with missing, malformed, or silent owner task files fail the audit', () => {
  const guideText = 'SEC-FAKE-05 SEC-FAKE-06 SEC-FAKE-07';
  const result = auditSecCoverage({
    guideText,
    allowlist: {
      'SEC-FAKE-05': 'ai-docs/tasks/99-nonexistent.md',
      'SEC-FAKE-06': 'somewhere/else.md',
      'SEC-FAKE-07': 'ai-docs/tasks/02-schemas.md',
    },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/02-schemas.md': '**Status:** todo\nno id declared here' },
  });
  expect(result.badOwners).toEqual([
    'SEC-FAKE-05 → ai-docs/tasks/99-nonexistent.md (task file does not exist)',
    'SEC-FAKE-06 → somewhere/else.md (not an ai-docs/tasks/NN-*.md path)',
    'SEC-FAKE-07 → ai-docs/tasks/02-schemas.md (no "SEC ids owned by THIS task:" marker declares the id)',
  ]);
});

// ---------------------------------------------------------------------------
// TASK 31 reproductions. `badOwners` used to do `taskText.includes(id)` — mention,
// not ownership — so it was wrong in BOTH directions: it accepted a file that named
// an id only to DISCLAIM it, and rejected a file that claimed its ids as a RANGE.
// ---------------------------------------------------------------------------

test('REPRODUCTION: an allowlist row whose owner file only DISCLAIMS the id fails the gate', () => {
  // Task 03's exact shape (03-crypto-canonical.md §Acceptance): the file names
  // SEC-OPLOG-01 precisely to hand it to task 07. A mention-based check reads that
  // disclaimer as a claim; a declaration-based one cannot.
  const disclaimingTask = [
    '**Status:** in-review',
    '',
    '- **SEC-OPLOG-06** — id verbatim in the test title: full RFC 8785 appendix vectors.',
    '  This is the only SEC-* id owned by this task (SEC-OPLOG-01/04/05/09 are tasks',
    '  07/15 — they consume these primitives).',
  ].join('\n');

  const result = auditSecCoverage({
    guideText: 'SEC-OPLOG-01 forged signature rejected',
    allowlist: { 'SEC-OPLOG-01': 'ai-docs/tasks/03-crypto-canonical.md' },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/03-crypto-canonical.md': disclaimingTask },
  });

  expect(result.badOwners).toEqual([
    'SEC-OPLOG-01 → ai-docs/tasks/03-crypto-canonical.md (no "SEC ids owned by THIS task:" marker declares the id)',
  ]);
});

test('INVERSE: a task declaring its ids as a RANGE owns every id in the range', () => {
  // Tasks 15/26 write "SEC-SYNC-01..10" — a string containing no literal SEC-SYNC-02.
  // The old substring check rejected this genuine claim.
  const rangeTask = ['**Status:** todo', '**SEC ids owned by THIS task:** SEC-SYNC-01..10'].join(
    '\n',
  );

  const result = auditSecCoverage({
    guideText: 'SEC-SYNC-02 revoked device rejected',
    allowlist: { 'SEC-SYNC-02': 'ai-docs/tasks/15-sync-client.md' },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/15-sync-client.md': rangeTask },
  });

  expect(result.badOwners).toEqual([]);
  expect(result.missing).toEqual([]);
});

test('a declared range does not spill past its own bounds', () => {
  const rangeTask = ['**Status:** todo', '**SEC ids owned by THIS task:** SEC-SYNC-01..03'].join(
    '\n',
  );
  const result = auditSecCoverage({
    guideText: 'SEC-SYNC-03 and SEC-SYNC-04',
    allowlist: {
      'SEC-SYNC-03': 'ai-docs/tasks/15-sync-client.md',
      'SEC-SYNC-04': 'ai-docs/tasks/15-sync-client.md',
    },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/15-sync-client.md': rangeTask },
  });
  expect(result.badOwners).toEqual([
    'SEC-SYNC-04 → ai-docs/tasks/15-sync-client.md (no "SEC ids owned by THIS task:" marker declares the id)',
  ]);
});

test('an id titled by a test AND still on the pending allowlist is a contradiction', () => {
  // The partial-coverage trap: a title claiming an id reads as "fully shipped" and
  // silently retires the id's other legs. If a row still says the id is owed, the
  // title and the row cannot both be true.
  const result = auditSecCoverage({
    guideText: 'SEC-MEDIA-01 replace after attach',
    allowlist: { 'SEC-MEDIA-01': 'ai-docs/tasks/18-media-client.md' },
    testTitles: ['SEC-MEDIA-01 replace after attach → 409'],
    taskFiles: {
      'ai-docs/tasks/18-media-client.md': [
        '**Status:** todo',
        '**SEC ids owned by THIS task:** SEC-MEDIA-01',
      ].join('\n'),
    },
  });
  expect(result.titledButPending).toEqual([
    'SEC-MEDIA-01 → ai-docs/tasks/18-media-client.md (a test titles the id, but the row still says it is owed)',
  ]);
});

test('two task files declaring the same id is an ownership conflict', () => {
  const result = auditSecCoverage({
    guideText: 'SEC-OPLOG-07 no mutation path',
    allowlist: { 'SEC-OPLOG-07': 'ai-docs/tasks/07-oplog-server.md' },
    testTitles: [],
    taskFiles: {
      'ai-docs/tasks/05-db-server.md': [
        '**Status:** done',
        '**SEC ids owned by THIS task:** SEC-OPLOG-07',
      ].join('\n'),
      'ai-docs/tasks/07-oplog-server.md': [
        '**Status:** todo',
        '**SEC ids owned by THIS task:** SEC-OPLOG-07',
      ].join('\n'),
    },
  });
  expect(result.ownershipConflicts).toEqual([
    'SEC-OPLOG-07 declared by ai-docs/tasks/05-db-server.md, ai-docs/tasks/07-oplog-server.md (exactly one task must own an id)',
  ]);
});

test('a malformed ownership marker fails loudly instead of silently declaring nothing', () => {
  // T-14: a guard whose failure mode is "silently checks nothing" is worse than none.
  const result = auditSecCoverage({
    guideText: 'SEC-RT-01 unauthenticated upgrade refused',
    allowlist: { 'SEC-RT-01': 'ai-docs/tasks/20-realtime.md' },
    testTitles: [],
    taskFiles: {
      'ai-docs/tasks/20-realtime.md': [
        '**Status:** todo',
        '**SEC ids owned by THIS task:** SEC-RT-01 and some prose the grammar forbids',
      ].join('\n'),
    },
  });
  expect(result.badOwners).toEqual([
    'SEC-RT-01 → ai-docs/tasks/20-realtime.md (malformed "SEC ids owned by THIS task:" marker: expected a comma-separated list of SEC ids/ranges or "none", got "SEC-RT-01 and some prose the grammar forbids")',
  ]);
});

test('the ownership marker is read only from the marker line, never from surrounding prose', () => {
  const proseOnly = [
    '**Status:** todo',
    '**SEC ids owned by THIS task:** none',
    '',
    'Prose mentioning SEC-RT-05 at length does not confer ownership.',
  ].join('\n');
  const result = auditSecCoverage({
    guideText: 'SEC-RT-05 client message abuse',
    allowlist: { 'SEC-RT-05': 'ai-docs/tasks/20-realtime.md' },
    testTitles: [],
    taskFiles: { 'ai-docs/tasks/20-realtime.md': proseOnly },
  });
  expect(result.badOwners).toEqual([
    'SEC-RT-05 → ai-docs/tasks/20-realtime.md (no "SEC ids owned by THIS task:" marker declares the id)',
  ]);
});

test('comment prose containing the word "it" followed by a quote is not a test title', () => {
  // Live defect: apps/server/.../sec-oplog-07.test.ts's ownership comment reads
  // `...does NOT title it ("SEC-OPLOG-07 is NOT titled...")`, and `\bit\s*\(` matched
  // the English "it". A comment could retire a SEC id.
  const source = [
    '// db-client/test/append-only.test.ts deliberately does NOT title it ("SEC-OPLOG-07',
    '// is NOT titled here on purpose: the id ships with the full rejection pipeline")',
    '/* describe("SEC-FAKE-10 in a block comment") */',
    "test('a genuine title', () => {});",
  ].join('\n');
  expect(extractTestTitles(source)).toEqual(['a genuine title']);
});

test('an allowlist entry whose owning task is done counts as stale', () => {
  const result = auditSecCoverage({
    guideText: 'SEC-FAKE-08',
    allowlist: { 'SEC-FAKE-08': 'ai-docs/tasks/02-schemas.md' },
    testTitles: [],
    taskFiles: {
      'ai-docs/tasks/02-schemas.md':
        '**Status:** done\n**SEC ids owned by THIS task:** SEC-FAKE-08',
    },
  });
  expect(result.staleAllowlist).toEqual([
    'SEC-FAKE-08 → ai-docs/tasks/02-schemas.md (task is done but the test never shipped)',
  ]);
});
