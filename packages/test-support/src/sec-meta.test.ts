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
  isPartialLegTitle,
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
  // The §2.1.6 rule's OWN denominator. `idsWithTitles` at zero would mean the title walk matched
  // nothing and every id-vs-title rule is vacuously green — the "silently checks nothing" mode.
  expect(result.checked.idsWithTitles, 'SEC ids with at least one verbatim title').toBeGreaterThan(
    40,
  );
  // Drift canary for the qualifier vocabulary. Qualified titles that carry an id are legitimate
  // (SEC-SYNC-02's "(client leg)" describe is correct — an unqualified `it` completes the id), so
  // some exist today and the vocabulary provably still matches this repo's prose.
  //
  // If this ever goes to zero, READ BEFORE DELETING. Two very different causes:
  //   (a) the vocabulary drifted — authors write a qualifier this regex misses, and
  //       `partialLegTitles` silently cannot fire. Fix the vocabulary.
  //   (b) the repo genuinely got clean — every id titled only by its completing test. That is the
  //       goal state, and then this floor is the wrong assertion: drop THIS line, not the rule.
  // The rule's own can-it-fire proof does not depend on this line — it is the synthetic
  // reproduction below, which is why (b) is safe to resolve by deleting this assertion.
  expect(
    result.checked.partialLegQualifiedTitles,
    'titles carrying both a SEC id and a partial-leg qualifier (see the note above before deleting)',
  ).toBeGreaterThan(0);

  expect(result.missing, 'SEC ids with neither a test title nor an allowlist entry').toEqual([]);
  expect(result.staleAllowlist, 'allowlist entries pointing at done tasks').toEqual([]);
  expect(result.badOwners, 'allowlist entries with invalid owning-task files').toEqual([]);
  expect(result.unknownEntries, 'allowlist entries not present in security-guide.md').toEqual([]);
  expect(result.titledButPending, 'ids both titled by a test and allowlisted as owed').toEqual([]);
  expect(result.ownershipConflicts, 'ids declared by more than one task file').toEqual([]);
  expect(
    result.partialLegTitles,
    'ids retired only by a title that calls itself a partial leg, with nothing declaring them',
  ).toEqual([]);
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

// ---------------------------------------------------------------------------
// TASK 61 reproductions. Task 31 left this open: "Can a partial-coverage title still claim an id?
// Yes — when no row exists", reasoning that retiring an id needs title→task attribution the gate
// does not have. It does not need attribution: when EVERY title claiming an id calls itself a
// leg/arm, the titles themselves say no test claims the whole id.
// ---------------------------------------------------------------------------

test('REPRODUCTION: a "(server leg)" title with no allowlist row no longer retires an id', () => {
  // sec-dev.test.ts:157's exact shape, verbatim. This is what was live and green: the title
  // embeds SEC-DEV-04, so `title.includes(id)` read the id as fully shipped, while §218's
  // client-side behaviours had no owner, no row, and no marker. Nothing contradicted it —
  // `titledButPending` needs a row to disagree with, and the row was never written.
  const result = auditSecCoverage({
    guideText: 'SEC-DEV-04 offline-revocation caveat holds',
    allowlist: {},
    testTitles: [
      'SEC-DEV-04 (server leg) revoked-device 401: every identity endpoint returns DEVICE_REVOKED for the revoked token, incl. the /me confirm-then-wipe probe',
    ],
    taskFiles: {},
  });

  expect(
    result.missing,
    'the title still counts as a title — this is not a missing-id case',
  ).toEqual([]);
  expect(
    result.titledButPending,
    'no row exists, so the old rule has nothing to contradict',
  ).toEqual([]);
  expect(result.partialLegTitles).toHaveLength(1);
  expect(result.partialLegTitles[0]).toContain('SEC-DEV-04');
  expect(result.partialLegTitles[0]).toContain('concedes it is a partial leg');
});

test('an unqualified title completes an id, even when a partial-leg title also names it', () => {
  // SEC-SYNC-02's real shape and the reason this rule is not a blunt "no qualifier in any title":
  // push.test.ts titles a `describe` "(client leg)" AND an `it` that carries no qualifier. The
  // unqualified one is the completing test, so the id is legitimately retired. A rule that fired
  // here would be wrong on correct code — the fastest way to get a gate routed around.
  const result = auditSecCoverage({
    guideText: 'SEC-SYNC-02 revoked device rejected',
    allowlist: {},
    testTitles: [
      'SEC-SYNC-02 — revoked device rejected (client leg)',
      'SEC-SYNC-02: ops pushed in the revocation window come back DEVICE_REVOKED and are kept client-side as rejected',
    ],
    taskFiles: {},
  });
  expect(result.partialLegTitles).toEqual([]);
});

test('a partial-leg title is legitimate once an allowlist row or a marker declares the id', () => {
  // The two declarative escapes (task 31's rails, not a second mechanism). Both must silence it.
  const titles = ['SEC-DEV-05 (server leg) private key never reaches the server'];
  const viaRow = auditSecCoverage({
    guideText: 'SEC-DEV-05 private key never leaves device',
    allowlist: { 'SEC-DEV-05': 'ai-docs/tasks/26-chaos-harness.md' },
    testTitles: titles,
    taskFiles: {
      'ai-docs/tasks/26-chaos-harness.md': [
        '**Status:** todo',
        '**SEC ids owned by THIS task:** SEC-DEV-05',
      ].join('\n'),
    },
  });
  expect(viaRow.partialLegTitles).toEqual([]);

  const viaMarker = auditSecCoverage({
    guideText: 'SEC-DEV-05 private key never leaves device',
    allowlist: {},
    testTitles: titles,
    taskFiles: {
      'ai-docs/tasks/26-chaos-harness.md': [
        '**Status:** todo',
        '**SEC ids owned by THIS task:** SEC-DEV-05',
      ].join('\n'),
    },
  });
  expect(viaMarker.partialLegTitles).toEqual([]);
});

test('the partial-leg vocabulary does not fire on words that merely contain it', () => {
  // `alarm` is not an arm; `legal` is not a leg. A false positive here ends the rule's
  // credibility, and "SEC-OPLOG-03 CHAIN_BROKEN raises a tamper alarm" is a real, correct title.
  expect(
    isPartialLegTitle('SEC-OPLOG-03 CHAIN_BROKEN raises a tamper alarm where CHAIN_GAP does not'),
  ).toBe(false);
  expect(isPartialLegTitle('SEC-FAKE-01 the legal hold path is honored')).toBe(false);
  expect(isPartialLegTitle('SEC-FAKE-02 harmless payloads are accepted')).toBe(false);
  // …and it does fire on the real qualifiers seen in this repo.
  expect(isPartialLegTitle('SEC-DEV-04 (server leg) revoked-device 401')).toBe(true);
  expect(isPartialLegTitle('SEC-AUTH-06 client arm — PIN command denials')).toBe(true);
  expect(isPartialLegTitle('SEC-DEV-07 (surfacing leg) key-compromise containment')).toBe(true);
  expect(isPartialLegTitle('SEC-AUTH-09 precursor — storage scan')).toBe(true);
  expect(
    isPartialLegTitle('a rolled-back clock cannot open the window early (SEC-AUTH-04s UI arm)'),
  ).toBe(true);
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
