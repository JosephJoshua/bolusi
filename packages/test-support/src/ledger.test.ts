// Ledger-integrity gate (task 66). `ai-docs/tasks/_index.md` is CLAUDE.md §2.6's single source of
// truth for "what's left", and nothing checked it against the filesystem — so a parallel wave filed
// two task files numbered 61 that auto-merged clean (different filenames) with no gate to catch it.
// The real-repo test runs the check over the actual tree; the synthetic tests below each break ONE
// leg and prove it goes red, so a green here means the four invariants hold, not that it looked at
// nothing (testing-guide T-11, T-14). (Leg 4 — the file-vs-row Status drift check — was retired by
// task 188, which collapsed the dual Status store; status lives once, in the row, so there is nothing
// left to drift.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { auditLedger, INDEX_BASENAME, KNOWN_STATUSES } from './ledger.js';
import { collectTrackedTaskFiles } from './sec-meta.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const INDEX_PATH = `ai-docs/tasks/${INDEX_BASENAME}`;

test('the ledger (_index.md) and the task files on disk agree', () => {
  const indexText = readFileSync(join(REPO_ROOT, INDEX_PATH), 'utf8');
  const taskFiles = Object.fromEntries(
    collectTrackedTaskFiles(REPO_ROOT).map((path) => [
      path,
      readFileSync(join(REPO_ROOT, path), 'utf8'),
    ]),
  );

  const result = auditLedger({ indexText, taskFiles });

  // T-14 — the gate states its own denominator and fails loudly on zero. The specific traps: a
  // glob that matches nothing (0 files) and a glob that swallows _index.md itself both report
  // "0 mismatches — green". These floors make either one fail here instead.
  expect(result.checked.taskFiles, 'numbered task files compared').toBeGreaterThan(30);
  expect(result.checked.indexRows, 'index rows compared').toBeGreaterThan(30);
  expect(result.checked.numbers, 'distinct task numbers on disk').toBeGreaterThan(30);

  expect(result.duplicateNumbers, 'task files sharing a number').toEqual([]);
  expect(result.duplicateRows, 'index rows sharing an id').toEqual([]);
  expect(result.orphanRows, 'index rows with no task file').toEqual([]);
  expect(result.orphanFiles, 'task files with no index row').toEqual([]);
  expect(result.unparseable, 'unparseable files or rows').toEqual([]);
});

// A compact, valid ledger used as the baseline the synthetic tests each mutate ONE way. It carries
// the 27a/27b split so every leg is falsified against a fixture that already contains the shape the
// gate must NOT flag.
const INDEX_HEADER = [
  '| id | title | status | depends on |',
  '| -- | ----- | ------ | ---------- |',
];
function ledger(rows: string[]): string {
  return [...INDEX_HEADER, ...rows].join('\n') + '\n';
}
// The audit reads only task-file PATHS now — task 188 removed the file `**Status:**` line the gate
// used to compare, so a task file's TEXT is no longer inspected. These fixtures just need to exist,
// so the body is arbitrary.
function file(): string {
  return '# Task\n\nbody\n';
}

test('a clean ledger with the 27a/27b split passes — two rows, one file, is legitimate', () => {
  const result = auditLedger({
    indexText: ledger([
      '| 01 | scaffold | done | — |',
      '| 27a | device-gates emulator lane | todo | 24 |',
      '| 27b | device-gates physical lane | blocked | 27a |',
    ]),
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      // ONE file for BOTH 27a and 27b — the split the task file calls out as correct.
      'ai-docs/tasks/27-device-gates.md': file(),
    },
  });
  expect(result.duplicateNumbers).toEqual([]);
  // 27a and 27b share a NUMBER but not an id — the split must not read as a duplicate row.
  expect(result.duplicateRows).toEqual([]);
  expect(result.orphanRows).toEqual([]);
  expect(result.orphanFiles).toEqual([]);
  expect(result.unparseable).toEqual([]);
  expect(result.checked).toEqual({ taskFiles: 2, indexRows: 3, numbers: 2 });
});

test('LEG 1: two task files sharing a number is a duplicate (the git-invisible collision)', () => {
  const result = auditLedger({
    indexText: ledger(['| 61 | sec-dev partial-leg retire | done | 31 |']),
    taskFiles: {
      'ai-docs/tasks/61-sec-dev-partial-leg-retire.md': file(),
      'ai-docs/tasks/61-user-interface-style-is-inert.md': file(),
    },
  });
  expect(result.duplicateNumbers).toEqual([
    '61 → 61-sec-dev-partial-leg-retire.md, 61-user-interface-style-is-inert.md (two task files share a number; git auto-merges this clean)',
  ]);
});

test('LEG 5: two index rows sharing an id is a duplicate row (a phantom task in the ledger)', () => {
  // review-66's exact reproduction. The first cut of this gate passed this GREEN: both row checks
  // keyed on the row's number, so the phantom `61` resolved to the real 61's file and was exempt
  // from the orphan check. Reachable by the natural repair of an index conflict ("keep both rows"),
  // and it leaves §2.6's source of truth listing a task that does not exist. Nothing else fires
  // here, which is precisely why this leg must exist on its own.
  const result = auditLedger({
    indexText: ledger(['| 61 | real | done | — |', '| 61 | phantom dupe | todo | — |']),
    taskFiles: { 'ai-docs/tasks/61-real.md': file() },
  });
  expect(result.duplicateRows).toEqual([
    '61 → 2 rows share the id "61" (statuses: done, todo); exactly one row per id',
  ]);
  // The hole this closes: every other check is silent on it.
  expect(result.orphanRows).toEqual([]);
  expect(result.duplicateNumbers).toEqual([]);
});

test('LEG 2: an index row with no matching task file is an orphan row', () => {
  const result = auditLedger({
    indexText: ledger([
      '| 01 | scaffold | done | — |',
      '| 71 | filed but never written | todo | — |',
    ]),
    taskFiles: { 'ai-docs/tasks/01-scaffold.md': file() },
  });
  expect(result.orphanRows).toEqual(['row 71 (status todo) has no task file numbered 71']);
  expect(result.orphanFiles).toEqual([]);
});

test('LEG 3: a task file with no index row is an orphan file', () => {
  const result = auditLedger({
    indexText: ledger(['| 01 | scaffold | done | — |']),
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      'ai-docs/tasks/72-filed-off-ledger.md': file(),
    },
  });
  expect(result.orphanFiles).toEqual(['72-filed-off-ledger.md (number 72) has no _index.md row']);
  expect(result.orphanRows).toEqual([]);
});

test('numbers are compared as integers: 1-, 2-, and 3-digit and the a/b suffix all resolve', () => {
  // sec-meta.ts's OWNER_PATH_PATTERN hard-codes \d{2} and breaks at task 100; this gate must not.
  const result = auditLedger({
    indexText: ledger([
      '| 1 | one digit | done | — |',
      '| 100 | three digits | todo | — |',
      '| 100b | three digits split | todo | — |',
    ]),
    taskFiles: {
      'ai-docs/tasks/1-one-digit.md': file(),
      'ai-docs/tasks/100-three-digits.md': file(),
    },
  });
  expect(result.duplicateNumbers).toEqual([]);
  expect(result.orphanRows).toEqual([]);
  expect(result.orphanFiles).toEqual([]);
  expect(result.checked).toEqual({ taskFiles: 2, indexRows: 3, numbers: 2 });
});

test('_index.md in the task-file map is excluded, never counted as a task file (T-14 trap)', () => {
  const indexText = ledger(['| 01 | scaffold | done | — |']);
  const result = auditLedger({
    indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      [INDEX_PATH]: indexText, // the walk returns _index.md too; it must not become a phantom file.
    },
  });
  expect(result.orphanFiles).toEqual([]);
  expect(result.unparseable).toEqual([]);
  expect(result.checked.taskFiles).toBe(1);
});

test('an empty tree reports a zero denominator instead of a false green', () => {
  const result = auditLedger({ indexText: ledger([]), taskFiles: {} });
  expect(result.duplicateNumbers).toEqual([]);
  expect(result.checked).toEqual({ taskFiles: 0, indexRows: 0, numbers: 0 });
  // The real-repo test's `> 30` floors are what turn this zero into a loud failure.
});

test('a bad task filename or an illegal row status is unparseable, never silently skipped', () => {
  const result = auditLedger({
    indexText: ledger([
      '| 01 | scaffold | done | — |',
      '| 02 | schemas | shipped | — |', // "shipped" is not one of the five legal values.
    ]),
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      'ai-docs/tasks/02-schemas.md': file(),
      'ai-docs/tasks/notes.md': '# stray file with no number\n',
    },
  });
  // Status now lives ONLY in the row (task 188), so an illegal status is caught on the ROW, not on a
  // file line — and a task file's text is never parsed, only its name. Sorted: `_` < `a`.
  expect(result.unparseable).toEqual([
    `${INDEX_BASENAME} row 02 has status "shipped", not one of ${KNOWN_STATUSES.join(', ')}`,
    'ai-docs/tasks/notes.md is neither _index.md nor a NN-slug.md task file',
  ]);
});
