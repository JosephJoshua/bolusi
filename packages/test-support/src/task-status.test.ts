// Unit tests for the task 71 single-writer (`scripts/task-status.mjs`). The writer edits a task's
// Status in BOTH places at once (the `_index.md` row cell + the file `**Status:**` line) so they
// cannot drift — task 66's ledger gate is only the backstop. Two things are proven here:
//   1. the writer's grammar is a PINNED MIRROR of the gate's (ledger.ts), so §2.8's "one grammar"
//      holds across the JS-script / TS-source boundary and the mirror fails CI if it ever drifts;
//   2. the writer's OUTPUT passes `auditLedger` — the actual gate — including the 27a/27b split,
//      which a naive "find the row for number 27" writer corrupts (T-12: test the sharp case).
import { expect, test } from 'vitest';

import {
  auditLedger,
  INDEX_BASENAME,
  KNOWN_STATUSES,
  ROW_ID_PATTERN,
  STATUS_LINE,
  TASK_FILE_BASENAME,
} from './ledger.js';
// @ts-expect-error — plain .mjs CLI without type declarations (mirrors lockfile-checks.test.ts).
import * as writer from '../../../scripts/task-status.mjs';

// A compact, valid ledger, same fixture shape as ledger.test.ts. `file()` carries the front-matter
// Status line the writer edits.
const INDEX_HEADER = [
  '| id | title | status | depends on |',
  '| -- | ----- | ------ | ---------- |',
];
function ledger(rows: string[]): string {
  return [...INDEX_HEADER, ...rows].join('\n') + '\n';
}
function file(status: string, trailer = ''): string {
  return `# Task\n\n**Status:** ${status}${trailer}\n\nbody\n`;
}
/** Read a single row's raw line back out of an index text, to assert siblings were left untouched. */
function rowLine(indexText: string, id: string): string | undefined {
  return indexText
    .split('\n')
    .find((line) => line.startsWith('|') && line.split('|')[1]?.trim() === id);
}

// ── 1. the mirror is pinned to the gate's grammar (§2.8 across the JS/TS boundary) ─────────────────
test('the writer grammar is the SAME grammar as the ledger gate — pinned, cannot drift', () => {
  expect(writer.KNOWN_STATUSES).toEqual([...KNOWN_STATUSES]);
  expect(writer.INDEX_BASENAME).toBe(INDEX_BASENAME);
  for (const [mirror, canonical] of [
    [writer.ROW_ID_PATTERN, ROW_ID_PATTERN],
    [writer.TASK_FILE_BASENAME, TASK_FILE_BASENAME],
    [writer.STATUS_LINE, STATUS_LINE],
  ] as Array<[RegExp, RegExp]>) {
    expect(mirror.source).toBe(canonical.source);
    expect(mirror.flags).toBe(canonical.flags);
  }
  // The five values are exactly the footer of _index.md — a self-check on the legal set.
  expect(writer.KNOWN_STATUSES).toEqual(['todo', 'in-progress', 'in-review', 'done', 'blocked']);
});

// ── 2. happy path: both locations change in one call ────────────────────────────────────────────────
test('a plain id updates the row cell and the file line together', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |', '| 49 | projections | in-progress | 16 |']),
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file('done'),
      'ai-docs/tasks/49-projections.md': file('in-progress'),
    },
    id: '49',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(result.indexChanged).toBe(true);
  expect(result.fileChanged).toBe(true);
  expect(result.filePath).toBe('ai-docs/tasks/49-projections.md');
  expect(rowLine(result.indexText, '49')).toBe('| 49 | projections | done | 16 |');
  expect(result.fileText).toContain('**Status:** done');
  // Untouched sibling row is byte-identical.
  expect(rowLine(result.indexText, '01')).toBe('| 01 | scaffold | done | — |');
  // And the writer's output passes the actual gate.
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file('done'),
      'ai-docs/tasks/49-projections.md': result.fileText,
    },
  });
  expect(audit.statusMismatches).toEqual([]);
  expect(audit.unparseable).toEqual([]);
});

// ── 3. the sharp case: 27a/27b → one file (T-12) ────────────────────────────────────────────────────
test('27a done updates the 27a row and the shared file, leaves 27b, and passes the gate', () => {
  const indexText = ledger([
    '| 01 | scaffold | done | — |',
    '| 27a | emulator lane | todo | 24 |',
    '| 27b | physical lane | blocked | 27a |',
  ]);
  const taskFiles = {
    'ai-docs/tasks/01-scaffold.md': file('done'),
    // ONE file for BOTH rows — the split the gate legitimately permits.
    'ai-docs/tasks/27-device-gates.md': file('todo'),
  };
  const before27b = rowLine(indexText, '27b');

  const result = writer.applyStatusChange({ indexText, taskFiles, id: '27a', status: 'done' });
  expect(result.ok).toBe(true);
  expect(result.number).toBe(27);
  expect(result.filePath).toBe('ai-docs/tasks/27-device-gates.md');
  // 27a row moved; 27b row is byte-identical; the single file now says done.
  expect(rowLine(result.indexText, '27a')).toBe('| 27a | emulator lane | done | 24 |');
  expect(rowLine(result.indexText, '27b')).toBe(before27b);
  expect(result.fileText).toContain('**Status:** done');

  // The result must pass task 66's gate: the file matches ONE of its rows (27a=done). 27b=blocked
  // does not flag — this is exactly the shape the gate permits.
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file('done'),
      'ai-docs/tasks/27-device-gates.md': result.fileText,
    },
  });
  expect(audit.statusMismatches).toEqual([]);
  expect(audit.duplicateRows).toEqual([]);
  expect(audit.orphanRows).toEqual([]);
  expect(audit.orphanFiles).toEqual([]);
  expect(audit.unparseable).toEqual([]);
});

test('a bare "27" is refused when only 27a/27b rows exist — it never corrupts the split', () => {
  const result = writer.applyStatusChange({
    indexText: ledger([
      '| 27a | emulator lane | todo | 24 |',
      '| 27b | physical lane | blocked | 27a |',
    ]),
    taskFiles: { 'ai-docs/tasks/27-device-gates.md': file('todo') },
    id: '27',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('UNKNOWN_ID');
  expect(result.indexText).toBeUndefined();
  expect(result.fileText).toBeUndefined();
});

// ── 4. validation refuses, computes nothing (no phantom row, no partial write) ──────────────────────
test('an unknown status is refused and produces no texts', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 17 | conflict-detection | in-progress | 07 |']),
    taskFiles: { 'ai-docs/tasks/17-conflict-detection.md': file('in-progress') },
    id: '17',
    status: 'frobnicate',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_STATUS');
  expect(result.message).toContain('frobnicate');
  expect(result.indexText).toBeUndefined();
  expect(result.fileText).toBeUndefined();
});

test('an unknown id is refused — no phantom row is invented', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |']),
    taskFiles: { 'ai-docs/tasks/01-scaffold.md': file('done') },
    id: '999',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('UNKNOWN_ID');
  expect(result.indexText).toBeUndefined();
});

test('a malformed id is refused before any lookup', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |']),
    taskFiles: { 'ai-docs/tasks/01-scaffold.md': file('done') },
    id: 'seventeen',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_ID');
});

test('a row present in the index but with no task file is refused (no half-write)', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |', '| 71 | ghost | todo | — |']),
    taskFiles: { 'ai-docs/tasks/01-scaffold.md': file('done') },
    id: '71',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('NO_FILE');
});

test('a file with no **Status:** line is refused rather than corrupted', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 02 | schemas | done | — |']),
    taskFiles: { 'ai-docs/tasks/02-schemas.md': '# Task\n\nno status line here\n' },
    id: '02',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('NO_STATUS_LINE');
});

test('a duplicate task-file number is refused, not guessed (ledger gate leg 1)', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 61 | thing | done | — |']),
    taskFiles: {
      'ai-docs/tasks/61-a.md': file('done'),
      'ai-docs/tasks/61-b.md': file('done'),
    },
    id: '61',
    status: 'in-review',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('DUPLICATE_FILE');
});

test('a duplicate index-row id is refused, not guessed (ledger gate leg 5)', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 61 | real | done | — |', '| 61 | phantom | todo | — |']),
    taskFiles: { 'ai-docs/tasks/61-real.md': file('done') },
    id: '61',
    status: 'in-review',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('DUPLICATE_ROW');
});

// ── 5. idempotent + drift-repair ────────────────────────────────────────────────────────────────────
test('running twice is a no-op: the second call changes neither location', () => {
  const indexText = ledger(['| 49 | projections | in-progress | 16 |']);
  const taskFiles = { 'ai-docs/tasks/49-projections.md': file('in-progress') };
  const first = writer.applyStatusChange({ indexText, taskFiles, id: '49', status: 'done' });
  expect(first.indexChanged).toBe(true);
  expect(first.fileChanged).toBe(true);
  const second = writer.applyStatusChange({
    indexText: first.indexText,
    taskFiles: { 'ai-docs/tasks/49-projections.md': first.fileText },
    id: '49',
    status: 'done',
  });
  expect(second.ok).toBe(true);
  expect(second.indexChanged).toBe(false);
  expect(second.fileChanged).toBe(false);
});

test('a drift already on disk (row done, file lagging) is reconciled by one call', () => {
  // The exact merge-writeback drift: index advanced, file left behind.
  const indexText = ledger(['| 49 | projections | done | 16 |']);
  const taskFiles = { 'ai-docs/tasks/49-projections.md': file('in-review') };
  // The gate is RED on this input before the writer runs.
  expect(auditLedger({ indexText, taskFiles }).statusMismatches.length).toBeGreaterThan(0);

  const result = writer.applyStatusChange({ indexText, taskFiles, id: '49', status: 'done' });
  expect(result.ok).toBe(true);
  expect(result.indexChanged).toBe(false); // row already done
  expect(result.fileChanged).toBe(true); //  file caught up
  // Gate GREEN after.
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: { 'ai-docs/tasks/49-projections.md': result.fileText },
  });
  expect(audit.statusMismatches).toEqual([]);
});

// ── 6. formatting preserved (the prettier-reflow trap, §2.11) ───────────────────────────────────────
test('trailing prose on the file Status line is preserved; only the token changes', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 54 | sec-auth | in-review | 31 |']),
    taskFiles: {
      'ai-docs/tasks/54-sec-auth.md': file('in-review', ' — premise refuted, no code owed'),
    },
    id: '54',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(result.fileText).toContain('**Status:** done — premise refuted, no code owed');
});

test('a legal but non-canonical status already in the row can be repaired', () => {
  // If a row somehow holds an illegal token, the writer must be able to set a legal one.
  const result = writer.applyStatusChange({
    indexText: ledger(['| 03 | crypto | shipped | — |']),
    taskFiles: { 'ai-docs/tasks/03-crypto.md': file('done') },
    id: '03',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(rowLine(result.indexText, '03')).toBe('| 03 | crypto | done | — |');
});

// ── 7. number handling and _index.md exclusion ──────────────────────────────────────────────────────
test('3-digit numbers and a split suffix resolve to the numbered file', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 100b | three digits split | todo | — |']),
    taskFiles: { 'ai-docs/tasks/100-three-digits.md': file('todo') },
    id: '100b',
    status: 'in-progress',
  });
  expect(result.ok).toBe(true);
  expect(result.number).toBe(100);
  expect(result.filePath).toBe('ai-docs/tasks/100-three-digits.md');
});

test('_index.md in the task-file map is never treated as a numbered task file', () => {
  const indexText = ledger(['| 01 | scaffold | done | — |']);
  const result = writer.applyStatusChange({
    indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file('todo'),
      [`ai-docs/tasks/${INDEX_BASENAME}`]: indexText,
    },
    id: '01',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(result.filePath).toBe('ai-docs/tasks/01-scaffold.md');
});
