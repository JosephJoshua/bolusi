// Single-writer for a task's Status (task 71). CLAUDE.md §2.6 keeps a task's Status in ONE place:
// the `status` cell of its `ai-docs/tasks/_index.md` row. (Until task 188 it ALSO lived in the file's
// `**Status:**` line; the two stores existed only so task 66's ledger gate could police their drift.
// Task 188 removed the file line and that gate leg — there is now a single source, so this writer
// touches ONE location and the drift is unconstructable, not merely caught after the fact.)
//
// GRAMMAR IS A PINNED MIRROR, NOT A SECOND PARSER (CLAUDE.md §2.8). The grammar values below are the
// same ones `packages/test-support/src/ledger.ts` (the gate) uses. They are mirrored here — not
// imported — only because this is a runtime `.mjs` CLI that cannot import the TS gate without a build
// step; this is the exact JS/TS boundary documented for `packages/i18n/scripts/error-code-registry.mjs`,
// and it is closed the same way: `packages/test-support/src/task-status.test.ts` PINS every value here
// to the canonical export in `ledger.ts`, so the mirror fails CI if it ever drifts (T-11).
//
// SURGICAL, NEVER REGENERATED. It replaces the single status token in the matched row's `status` cell,
// preserving every other byte — column padding, and trailing prose like `| … | in-review — moved |`.
// It never re-serialises the table: a full parse+print would reformat rows and defeat the point (the
// prettier-reflow trap, §2.11). Validation is complete BEFORE the write, so a refused change computes
// nothing and writes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ── grammar mirror (pinned to ledger.ts by task-status.test.ts) ────────────────────────────────────
/** The five legal Status values (footer of `_index.md`; ledger.ts `KNOWN_STATUSES`). */
export const KNOWN_STATUSES = ['todo', 'in-progress', 'in-review', 'done', 'blocked'];
/** An index-row id: a number with an optional split suffix (`27a`). ledger.ts `ROW_ID_PATTERN`. */
export const ROW_ID_PATTERN = /^(\d+)([a-z]*)$/;
/** A numbered task file's basename: `NN-slug.md`. ledger.ts `TASK_FILE_BASENAME`. Re-exported for
 *  task-new.mjs (which imports it here); this writer no longer reads task files, but the mirror stays
 *  pinned so the two task tools keep one filename grammar (§2.8). */
export const TASK_FILE_BASENAME = /^(\d+)-[\w-]+\.md$/;
/** The ledger file itself — never one of its own task-file rows. ledger.ts `INDEX_BASENAME`. */
export const INDEX_BASENAME = '_index.md';

/** A row's status cell holds a single token surrounded by column padding; this swaps the token and
 *  preserves the padding. NOT part of the shared ledger grammar — a formatting-preserving helper. */
const STATUS_CELL = /^(\s*)(\S+)(\s*)$/;

/** Table cells are delimited by pipes that are NOT backslash-escaped; `\|` is legal inside a title
 *  (GitHub table spec). Mirrors ledger.ts `SPLIT_ON_UNESCAPED_PIPE` — both parsers read one grammar. */
const SPLIT_ON_UNESCAPED_PIPE = new RegExp(String.raw`(?<!\\)\|`);

/**
 * Compute the new `_index.md` text for one `<id> <status>` change, WITHOUT writing anything. Pure and
 * disk-free so it is exhaustively unit-testable. Returns `{ ok: true, … }` with the new text, or
 * `{ ok: false, code, message }` and NO text — the atomicity guarantee lives here: an error means
 * nothing is computed, so the CLI writes nothing.
 *
 * @param {{ indexText: string, id: string, status: string }} input
 * @returns {{ ok: true, indexText: string, indexChanged: boolean, previous: { row: string } }
 *          | { ok: false, code: string, message: string }}
 */
export function applyStatusChange({ indexText, id, status }) {
  // 1. The status must be one of the five legal values — else refuse, nothing computed.
  if (!KNOWN_STATUSES.includes(status)) {
    return {
      ok: false,
      code: 'BAD_STATUS',
      message: `unknown status "${status}" — expected one of ${KNOWN_STATUSES.join(', ')}`,
    };
  }

  // 2. The id must be well-formed (`49`, `27a`).
  const idMatch = ROW_ID_PATTERN.exec(id);
  if (!idMatch) {
    return { ok: false, code: 'BAD_ID', message: `"${id}" is not a task id (e.g. 49 or 27a)` };
  }

  // 3. Find the ONE index row whose id cell equals `id` exactly (not by number — `27a` != `27b`,
  //    so setting 27a must never touch 27b). Rebuild only that line's status cell.
  const lines = indexText.split('\n');
  const matchedRows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    // Split on UNESCAPED pipes only. A title MAY contain a pipe escaped as `\|` per GitHub's table
    // spec (row 76 does: "the column holds `'id'\|'en'`"); a bare `.split('|')` shifts every later
    // cell so `status` parses as title text and this tool refuses a legal row. `ledger.ts` already
    // fixed this exact bug (SPLIT_ON_UNESCAPED_PIPE) — the two parsers must agree (§2.8). The
    // escaped pipe stays inside its cell, so the `join('|')` rebuild below round-trips exactly.
    const parts = line.split(SPLIT_ON_UNESCAPED_PIPE); // ['', ' id ', ' title ', ' status ', ' deps ', '']
    if (parts.length < 5) continue; // not a 4-column task row
    if (parts[1].trim() !== id) continue;
    matchedRows.push({ lineIndex: i, parts });
  }
  if (matchedRows.length === 0) {
    return { ok: false, code: 'UNKNOWN_ID', message: `no ${INDEX_BASENAME} row with id "${id}"` };
  }
  if (matchedRows.length > 1) {
    // Two rows share the id — the phantom-task collision the ledger gate flags. Refuse; do not guess.
    return {
      ok: false,
      code: 'DUPLICATE_ROW',
      message: `${matchedRows.length} ${INDEX_BASENAME} rows share the id "${id}" — fix the duplicate first (ledger gate leg 5)`,
    };
  }
  const { lineIndex, parts } = matchedRows[0];
  const cell = STATUS_CELL.exec(parts[3]);
  if (!cell) {
    return {
      ok: false,
      code: 'BAD_ROW',
      message: `row "${id}" status cell is not a single token: "${parts[3]}"`,
    };
  }
  const previousRowStatus = cell[2];
  const newParts = parts.slice();
  newParts[3] = `${cell[1]}${status}${cell[3]}`;
  const newLines = lines.slice();
  newLines[lineIndex] = newParts.join('|');
  const newIndexText = newLines.join('\n');

  return {
    ok: true,
    indexText: newIndexText,
    indexChanged: newIndexText !== indexText,
    previous: { row: previousRowStatus },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TASKS_DIR = 'ai-docs/tasks';

function runCli(argv) {
  const [id, status] = argv;
  if (!id || !status) {
    console.error('usage: pnpm task:status <id> <status>');
    console.error(`  <id>     a task id, e.g. 49 or 27a`);
    console.error(`  <status> one of: ${KNOWN_STATUSES.join(', ')}`);
    return 2;
  }

  const indexPath = join(REPO_ROOT, TASKS_DIR, INDEX_BASENAME);
  const indexText = readFileSync(indexPath, 'utf8');
  const result = applyStatusChange({ indexText, id, status });
  if (!result.ok) {
    console.error(`task:status: ${result.message}`);
    return 1;
  }

  if (!result.indexChanged) {
    console.log(`task:status: ${id} already ${status} — no change`);
    return 0;
  }

  writeFileSync(indexPath, result.indexText);
  console.log(`task:status: ${id} → ${status} (row ${result.previous.row}→${status})`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(runCli(process.argv.slice(2)));
}
