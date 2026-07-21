// Single-writer for a task's Status (task 71). CLAUDE.md §2.6 keeps a task's Status in TWO places:
// the `status` cell of its `ai-docs/tasks/_index.md` row and the file's `**Status:**` line. The
// merge / state-change procedure updates the row and forgets the file, so every merged task drifts
// (measured: 32 files in one session). Task 66's ledger gate CATCHES the drift post-hoc; this helper
// makes it not happen — it edits BOTH locations in ONE invocation, so they cannot disagree.
//
// GRAMMAR IS A PINNED MIRROR, NOT A SECOND PARSER (CLAUDE.md §2.8). The four grammar values below are
// the same ones `packages/test-support/src/ledger.ts` (the gate) uses. They are mirrored here — not
// imported — only because this is a runtime `.mjs` CLI that cannot import the TS gate without a build
// step; this is the exact JS/TS boundary documented for `packages/i18n/scripts/error-code-registry.mjs`,
// and it is closed the same way: `packages/test-support/src/task-status.test.ts` PINS every value here
// to the canonical export in `ledger.ts`, so the mirror fails CI if it ever drifts (T-11).
//
// SURGICAL, NEVER REGENERATED. It replaces the single status token in the matched row line and the
// single token after `**Status:**`, preserving every other byte — column padding, and trailing prose
// like `**Status:** in-review — premise moved`. It never re-serialises the table: a full parse+print
// would reformat rows and defeat the point (the prettier-reflow trap, §2.11). Validation is complete
// BEFORE any write, so a partial "index updated, file not" is unreachable — write both or neither.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// ── grammar mirror (pinned to ledger.ts by task-status.test.ts) ────────────────────────────────────
/** The five legal Status values (footer of `_index.md`; ledger.ts `KNOWN_STATUSES`). */
export const KNOWN_STATUSES = ['todo', 'in-progress', 'in-review', 'done', 'blocked'];
/** An index-row id: a number with an optional split suffix (`27a`). ledger.ts `ROW_ID_PATTERN`. */
export const ROW_ID_PATTERN = /^(\d+)([a-z]*)$/;
/** A numbered task file's basename: `NN-slug.md`. ledger.ts `TASK_FILE_BASENAME`. */
export const TASK_FILE_BASENAME = /^(\d+)-[\w-]+\.md$/;
/** The front-matter Status line; `\S+` grabs only the token. ledger.ts `STATUS_LINE`. */
export const STATUS_LINE = /\*\*Status:\*\*\s*(\S+)/;
/** The ledger file itself — never one of its own task-file rows. ledger.ts `INDEX_BASENAME`. */
export const INDEX_BASENAME = '_index.md';

/** A row's status cell holds a single token surrounded by column padding; this swaps the token and
 *  preserves the padding. NOT part of the shared ledger grammar — a formatting-preserving helper. */
const STATUS_CELL = /^(\s*)(\S+)(\s*)$/;

/** Table cells are delimited by pipes that are NOT backslash-escaped; `\|` is legal inside a title
 *  (GitHub table spec). Mirrors ledger.ts `SPLIT_ON_UNESCAPED_PIPE` — both parsers read one grammar. */
const SPLIT_ON_UNESCAPED_PIPE = new RegExp(String.raw`(?<!\\)\|`);

/**
 * Compute the new `_index.md` text and the new task-file text for one `<id> <status>` change,
 * WITHOUT writing anything. Pure and disk-free so it is exhaustively unit-testable. Returns
 * `{ ok: true, … }` with both new texts, or `{ ok: false, code, message }` and NO texts — the
 * atomicity guarantee lives here: an error means nothing is computed, so the CLI writes nothing.
 *
 * @param {{ indexText: string, taskFiles: Record<string, string>, id: string, status: string }} input
 *   `taskFiles` maps path -> text (same shape as the ledger gate's input; `_index.md` is ignored).
 * @returns {{ ok: true, indexText: string, filePath: string, fileText: string,
 *             indexChanged: boolean, fileChanged: boolean, number: number, previous: { row: string, file: string } }
 *          | { ok: false, code: string, message: string }}
 */
export function applyStatusChange({ indexText, taskFiles, id, status }) {
  // 1. The status must be one of the five legal values — else refuse, nothing computed.
  if (!KNOWN_STATUSES.includes(status)) {
    return {
      ok: false,
      code: 'BAD_STATUS',
      message: `unknown status "${status}" — expected one of ${KNOWN_STATUSES.join(', ')}`,
    };
  }

  // 2. The id must be well-formed (`49`, `27a`). Its number is what resolves to a file.
  const idMatch = ROW_ID_PATTERN.exec(id);
  if (!idMatch) {
    return { ok: false, code: 'BAD_ID', message: `"${id}" is not a task id (e.g. 49 or 27a)` };
  }
  const number = Number(idMatch[1]);

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

  // 4. Find the ONE task file numbered `number` and swap its `**Status:**` token, preserving prose.
  const candidates = [];
  for (const [path, text] of Object.entries(taskFiles)) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (basename === INDEX_BASENAME) continue;
    const fileMatch = TASK_FILE_BASENAME.exec(basename);
    if (!fileMatch || Number(fileMatch[1]) !== number) continue;
    candidates.push({ path, text });
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'NO_FILE',
      message: `no task file numbered ${number} for id "${id}"`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'DUPLICATE_FILE',
      message: `${candidates.length} task files numbered ${number} (${candidates
        .map((c) => c.path.slice(c.path.lastIndexOf('/') + 1))
        .sort()
        .join(', ')}) — fix the collision first (ledger gate leg 1)`,
    };
  }
  const target = candidates[0];
  const statusMatch = STATUS_LINE.exec(target.text);
  if (!statusMatch) {
    return {
      ok: false,
      code: 'NO_STATUS_LINE',
      message: `${target.path} has no "**Status:**" line`,
    };
  }
  const previousFileStatus = statusMatch[1];
  // Replace exactly the token bytes located by the pinned STATUS_LINE — no second regex.
  const tokenStart = statusMatch.index + statusMatch[0].lastIndexOf(previousFileStatus);
  const newFileText =
    target.text.slice(0, tokenStart) +
    status +
    target.text.slice(tokenStart + previousFileStatus.length);

  return {
    ok: true,
    indexText: newIndexText,
    filePath: target.path,
    fileText: newFileText,
    indexChanged: newIndexText !== indexText,
    fileChanged: newFileText !== target.text,
    number,
    previous: { row: previousRowStatus, file: previousFileStatus },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TASKS_DIR = 'ai-docs/tasks';

/** Read `_index.md` + every `ai-docs/tasks/NN-*.md` off disk into the pure function's input shape. */
function readLedger(repoRoot) {
  const dir = join(repoRoot, TASKS_DIR);
  const indexText = readFileSync(join(dir, INDEX_BASENAME), 'utf8');
  const taskFiles = {};
  for (const basename of readdirSync(dir)) {
    if (!basename.endsWith('.md') || basename === INDEX_BASENAME) continue;
    taskFiles[`${TASKS_DIR}/${basename}`] = readFileSync(join(dir, basename), 'utf8');
  }
  return { indexText, taskFiles };
}

function runCli(argv) {
  const [id, status] = argv;
  if (!id || !status) {
    console.error('usage: pnpm task:status <id> <status>');
    console.error(`  <id>     a task id, e.g. 49 or 27a`);
    console.error(`  <status> one of: ${KNOWN_STATUSES.join(', ')}`);
    return 2;
  }

  const { indexText, taskFiles } = readLedger(REPO_ROOT);
  const result = applyStatusChange({ indexText, taskFiles, id, status });
  if (!result.ok) {
    console.error(`task:status: ${result.message}`);
    return 1;
  }

  if (!result.indexChanged && !result.fileChanged) {
    console.log(`task:status: ${id} already ${status} (index row + file) — no change`);
    return 0;
  }

  // Atomic-ish write: file first, then index; if the index write throws, restore the file so the
  // two locations never end up disagreeing (§2.11 "write both or neither").
  const indexPath = join(REPO_ROOT, TASKS_DIR, INDEX_BASENAME);
  const filePath = join(REPO_ROOT, result.filePath);
  const originalFileText = taskFiles[result.filePath];
  if (result.fileChanged) writeFileSync(filePath, result.fileText);
  try {
    if (result.indexChanged) writeFileSync(indexPath, result.indexText);
  } catch (err) {
    if (result.fileChanged) writeFileSync(filePath, originalFileText);
    throw err;
  }

  const rowNote = result.indexChanged
    ? `row ${result.previous.row}→${status}`
    : `row already ${status}`;
  const fileNote = result.fileChanged
    ? `${result.filePath} ${result.previous.file}→${status}`
    : `${result.filePath} already ${status}`;
  console.log(`task:status: ${id} → ${status} (${rowNote}; ${fileNote})`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(runCli(process.argv.slice(2)));
}
