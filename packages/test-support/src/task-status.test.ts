// Unit tests for the task 71 single-writer (`scripts/task-status.mjs`). Task 188 collapsed the dual
// Status store: a task's Status now lives in ONE place — the `status` cell of its `_index.md` row —
// so this writer edits ONE location and the old file-vs-row drift is unconstructable, not merely
// caught after the fact. Two things are proven here:
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
  TASK_FILE_BASENAME,
} from './ledger.js';
// @ts-expect-error — plain .mjs CLI without type declarations (mirrors lockfile-checks.test.ts).
import * as writer from '../../../scripts/task-status.mjs';

// A compact, valid ledger, same fixture shape as ledger.test.ts.
const INDEX_HEADER = [
  '| id | title | status | depends on |',
  '| -- | ----- | ------ | ---------- |',
];
function ledger(rows: string[]): string {
  return [...INDEX_HEADER, ...rows].join('\n') + '\n';
}
/** The audit reads only task-file PATHS now; bodies are arbitrary (task 188). */
function file(): string {
  return '# Task\n\nbody\n';
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
  ] as Array<[RegExp, RegExp]>) {
    expect(mirror.source).toBe(canonical.source);
    expect(mirror.flags).toBe(canonical.flags);
  }
  // The five values are exactly the footer of _index.md — a self-check on the legal set.
  expect(writer.KNOWN_STATUSES).toEqual(['todo', 'in-progress', 'in-review', 'done', 'blocked']);
});

// ── 2. happy path: the one location — the row cell — changes ─────────────────────────────────────────
test('a plain id updates the row status cell and reports the previous value', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |', '| 49 | projections | in-progress | 16 |']),
    id: '49',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(result.indexChanged).toBe(true);
  expect(result.previous.row).toBe('in-progress');
  expect(rowLine(result.indexText, '49')).toBe('| 49 | projections | done | 16 |');
  // Untouched sibling row is byte-identical.
  expect(rowLine(result.indexText, '01')).toBe('| 01 | scaffold | done | — |');
  // And the writer's output passes the actual gate (rows 01+49 both have a file → no orphan).
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      'ai-docs/tasks/49-projections.md': file(),
    },
  });
  expect(audit.orphanRows).toEqual([]);
  expect(audit.unparseable).toEqual([]);
});

// ── 3. the sharp case: 27a/27b → one file (T-12) ────────────────────────────────────────────────────
test('27a done updates the 27a row, leaves 27b, and passes the gate', () => {
  const indexText = ledger([
    '| 01 | scaffold | done | — |',
    '| 27a | emulator lane | todo | 24 |',
    '| 27b | physical lane | blocked | 27a |',
  ]);
  const before27b = rowLine(indexText, '27b');

  const result = writer.applyStatusChange({ indexText, id: '27a', status: 'done' });
  expect(result.ok).toBe(true);
  expect(result.previous.row).toBe('todo');
  // 27a row moved; 27b row is byte-identical.
  expect(rowLine(result.indexText, '27a')).toBe('| 27a | emulator lane | done | 24 |');
  expect(rowLine(result.indexText, '27b')).toBe(before27b);

  // The result must pass task 66's gate: 27a/27b are distinct ids against one file — not a dup row,
  // not an orphan. 27b staying blocked is exactly the shape the gate permits.
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': file(),
      'ai-docs/tasks/27-device-gates.md': file(),
    },
  });
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
    id: '27',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('UNKNOWN_ID');
  expect(result.indexText).toBeUndefined();
});

// ── 4. validation refuses, computes nothing (no phantom row, no partial write) ──────────────────────
test('an unknown status is refused and produces no text', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 17 | conflict-detection | in-progress | 07 |']),
    id: '17',
    status: 'frobnicate',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_STATUS');
  expect(result.message).toContain('frobnicate');
  expect(result.indexText).toBeUndefined();
});

test('an unknown id is refused — no phantom row is invented', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 01 | scaffold | done | — |']),
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
    id: 'seventeen',
    status: 'done',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_ID');
});

test('a duplicate index-row id is refused, not guessed (ledger gate leg 5)', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 61 | real | done | — |', '| 61 | phantom | todo | — |']),
    id: '61',
    status: 'in-review',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('DUPLICATE_ROW');
});

// ── 5. idempotent ─────────────────────────────────────────────────────────────────────────────────
test('running twice is a no-op: the second call changes nothing', () => {
  const indexText = ledger(['| 49 | projections | in-progress | 16 |']);
  const first = writer.applyStatusChange({ indexText, id: '49', status: 'done' });
  expect(first.indexChanged).toBe(true);
  const second = writer.applyStatusChange({
    indexText: first.indexText,
    id: '49',
    status: 'done',
  });
  expect(second.ok).toBe(true);
  expect(second.indexChanged).toBe(false);
});

// ── 6. formatting preserved (the prettier-reflow trap, §2.11) ───────────────────────────────────────
test('only the status token changes; cell padding and other cells are preserved byte-for-byte', () => {
  // A surgical writer swaps the status token and NOTHING else — odd padding around the token and any
  // trailing prose in a neighbouring cell must survive verbatim. A full parse+print would reflow it.
  const indexText = ledger(['| 54 | sec-auth |  in-review  | 31 — deferred to wave 3 |']);
  const result = writer.applyStatusChange({ indexText, id: '54', status: 'done' });
  expect(result.ok).toBe(true);
  expect(rowLine(result.indexText, '54')).toBe(
    '| 54 | sec-auth |  done  | 31 — deferred to wave 3 |',
  );
});

test('a legal but non-canonical status already in the row can be repaired', () => {
  // If a row somehow holds an illegal token, the writer must be able to set a legal one.
  const result = writer.applyStatusChange({
    indexText: ledger(['| 03 | crypto | shipped | — |']),
    id: '03',
    status: 'done',
  });
  expect(result.ok).toBe(true);
  expect(result.previous.row).toBe('shipped');
  expect(rowLine(result.indexText, '03')).toBe('| 03 | crypto | done | — |');
});

// ── 7. id shapes: 1-, 2-, 3-digit and a split suffix all resolve by EXACT id ─────────────────────────
test('a 3-digit id with a split suffix matches its exact row, not by number', () => {
  const result = writer.applyStatusChange({
    indexText: ledger(['| 100b | three digits split | todo | — |']),
    id: '100b',
    status: 'in-progress',
  });
  expect(result.ok).toBe(true);
  expect(rowLine(result.indexText, '100b')).toBe('| 100b | three digits split | in-progress | — |');
});
