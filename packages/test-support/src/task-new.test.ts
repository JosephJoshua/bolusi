// Unit tests for `scripts/task-new.mjs` (task 173): the `pnpm task:new` allocator. It picks the next
// id against origin/main ∪ the local tree and writes the file + `_index.md` row together. Same
// fixture shape as task-status.test.ts; the REAL gate (`auditLedger`, task 66) is the oracle for
// "the tool's output is a valid ledger", and the FALSIFY block proves the gate still reds when the
// tool writes a row without its file — so adding the tool did not weaken the backstop.
import { expect, test } from 'vitest';

import { auditLedger } from './ledger.js';
// @ts-expect-error — plain .mjs CLI without type declarations (mirrors task-status.test.ts).
import * as taskNew from '../../../scripts/task-new.mjs';

const INDEX_HEADER = [
  '| id | title | status | depends on |',
  '| -- | ----- | ------ | ---------- |',
];
const FOOTER = ['', '**Status values:** `todo · in-progress · done`'];
function ledger(rows: string[]): string {
  return [...INDEX_HEADER, ...rows, ...FOOTER].join('\n') + '\n';
}
/** Read one row's raw line back out, to assert placement / siblings. */
function rowLine(indexText: string, id: string): string | undefined {
  return indexText
    .split('\n')
    .find((line) => line.startsWith('|') && line.split('|')[1]?.trim() === id);
}

const LOCAL = ledger([
  '| 01 | scaffold | done | — |',
  '| 27a | emulator lane | todo | 24 |',
  '| 49 | projections | done | 16 |',
]);
const LOCAL_FILES = ['01-scaffold.md', '27-device-gates.md', '49-projections.md'];

// ── 1. positive control: a legitimately-next task lands, and its output passes the real gate ───────
test('creates the next id, writes the row + file, and the result passes auditLedger', () => {
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: LOCAL,
    title: 'A brand new thing',
    deps: ['49'],
    status: 'todo',
  });
  expect(result.ok).toBe(true);
  expect(result.id).toBe(50);
  expect(result.filePath).toBe('ai-docs/tasks/50-a-brand-new-thing.md');
  // The row is inserted AFTER the last table row (before the footer), not at end-of-file.
  expect(rowLine(result.indexText, '50')).toBe('| 50 | A brand new thing | todo | 49 |');
  expect(result.indexText).toContain('**Status values:**'); // footer survived, row is above it
  expect(result.indexText.indexOf('| 50 |')).toBeLessThan(
    result.indexText.indexOf('**Status values:**'),
  );
  // The generated file has NO **Status:** line — task 188 collapsed the dual store; status lives
  // once, in the _index.md row asserted above.
  expect(result.fileText).toContain('# TASK 50 — A brand new thing');
  expect(result.fileText).not.toContain('**Status:**');

  // The tool's OUTPUT is a valid ledger by the actual gate — every row resolves to a file, no orphan.
  // Task-file bodies are arbitrary now: the gate reads only filenames (task 188).
  const audit = auditLedger({
    indexText: result.indexText,
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': 'body\n',
      'ai-docs/tasks/27-device-gates.md': 'body\n',
      'ai-docs/tasks/49-projections.md': 'body\n',
      [result.filePath]: result.fileText,
    },
  });
  expect(audit.orphanRows ?? []).toEqual([]);
  expect(audit.unparseable).toEqual([]);
});

// ── 2. the id is allocated ABOVE origin/main, not just the local tree ──────────────────────────────
test('allocates above the highest id on origin/main even when the local tree is behind', () => {
  // origin/main already has 185; the local tree only knows up to 49 (a stale base). The dominant
  // collision cause. The next id must be 186, not 50 — proving the origin read wins.
  const origin = ledger(['| 01 | scaffold | done | — |', '| 185 | dedup backlog | todo | — |']);
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: origin,
    title: 'later task',
  });
  expect(result.ok).toBe(true);
  expect(result.id).toBe(186);
});

test('a local id higher than origin still wins (union, not just origin)', () => {
  const origin = ledger(['| 01 | scaffold | done | — |']);
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL, // has 49
    localBasenames: [...LOCAL_FILES, '200-a-local-only-file.md'], // and a file at 200
    originIndexText: origin,
    title: 'x',
  });
  expect(result.ok).toBe(true);
  expect(result.id).toBe(201);
});

// ── 3. refusals — never overwrite, never allocate blind ────────────────────────────────────────────
test('refuses a title whose slug collides with an existing file', () => {
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: LOCAL,
    title: 'Projections!!!', // slugifies to "projections" → collides with 49-projections.md
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('SLUG_TAKEN');
});

test('refuses a title with no alphanumerics (empty slug)', () => {
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: LOCAL,
    title: '—— !!! ——',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_SLUG');
});

test('refuses an unknown status', () => {
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: LOCAL,
    title: 'x',
    status: 'shipped',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('BAD_STATUS');
});

test('refuses to allocate over a ledger it parsed as EMPTY (T-14 denominator guard)', () => {
  // Both origin and local read as zero ids → the parse is broken, not the ledger genuinely empty.
  // Allocating "1" here would stamp id 1 over a real populated repo whose index the parser misread.
  const result = taskNew.computeNewTask({
    localIndexText: 'no table here at all\n',
    localBasenames: ['not-a-task.txt'],
    originIndexText: 'also nothing\n',
    title: 'x',
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('EMPTY_LEDGER');
});

// ── 4. the backstop still backstops (task 173): break atomicity, the ledger gate must red ─────────
test('a row written WITHOUT its file is caught by auditLedger — the gate still guards the new tool', () => {
  const result = taskNew.computeNewTask({
    localIndexText: LOCAL,
    localBasenames: LOCAL_FILES,
    originIndexText: LOCAL,
    title: 'half written',
  });
  expect(result.ok).toBe(true);
  // Simulate the failure mode task:new's atomic write exists to prevent: the index row landed but the
  // file did not. The ledger gate (the loud backstop this tool must NOT weaken) must flag it.
  const audit = auditLedger({
    indexText: result.indexText, // has the new row…
    taskFiles: {
      'ai-docs/tasks/01-scaffold.md': 'body\n',
      'ai-docs/tasks/27-device-gates.md': 'body\n',
      'ai-docs/tasks/49-projections.md': 'body\n',
      // …but NO file for the new id.
    },
  });
  const flagged = [...(audit.orphanRows ?? []), ...audit.unparseable].join(' ');
  expect(flagged).toContain(String(result.id));
});

// ── 4b. the row inserts after the last DATA row, never into a footer that carries a `|` line (173 review) ──
test('a footer line that starts with `|` does not capture the insertion point', () => {
  // The 173 reviewer's defect: matching `startsWith('|')` would insert the new row AFTER a footer
  // pipe-line (a legend sub-table), splicing it into the prose and malforming the table. Only a
  // `| <digit>` data row is a valid insertion anchor.
  const withPipeFooter =
    [...INDEX_HEADER, '| 01 | scaffold | done | — |', '| 49 | projections | done | 16 |'].join(
      '\n',
    ) +
    '\n\n**Status values:** legend below\n\n| key | meaning |\n| --- | ------- |\n| ✓ | done |\n';
  const result = taskNew.computeNewTask({
    localIndexText: withPipeFooter,
    localBasenames: ['01-scaffold.md', '49-projections.md'],
    originIndexText: withPipeFooter,
    title: 'after data row',
  });
  expect(result.ok).toBe(true);
  expect(result.id).toBe(50);
  const lines = result.indexText.split('\n');
  const newRowIdx = lines.findIndex((l: string) => l.startsWith('| 50 |'));
  const legendIdx = lines.findIndex((l: string) => l.startsWith('| key |'));
  const lastDataIdx = lines.findIndex((l: string) => l.startsWith('| 49 |'));
  // The new row sits immediately after the last DATA row (49), BEFORE the footer legend table.
  expect(newRowIdx).toBe(lastDataIdx + 1);
  expect(newRowIdx).toBeLessThan(legendIdx);
  expect(result.indexText).toContain('**Status values:** legend below');
});

// ── 5. slugify is total and safe ───────────────────────────────────────────────────────────────────
test('slugify lowercases, collapses non-alphanumerics, trims, and caps length', () => {
  expect(taskNew.slugify('Hello, World!')).toBe('hello-world');
  expect(taskNew.slugify('  leading/trailing  ')).toBe('leading-trailing');
  expect(taskNew.slugify('a'.repeat(100)).length).toBeLessThanOrEqual(60);
  expect(taskNew.slugify('###')).toBe('');
});
