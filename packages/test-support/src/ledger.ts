// Ledger-integrity gate (CLAUDE.md §2.6). `ai-docs/tasks/_index.md` is the normative
// "what's left" ledger, and until task 66 NOTHING checked it against the filesystem — so in one
// parallel wave three agents computed "the next free number" from a tree that had already moved
// and filed COLLIDING task numbers (61 twice, 62 twice). The collision auto-merges CLEAN in git
// because the filenames differ (`61-foo.md` vs `61-bar.md`): git has no reason to know a
// uniqueness constraint is encoded in the number embedded in a filename, so it is right to see no
// conflict. Only a gate that runs AFTER the merge, when the tree has stopped moving, catches it.
//
// This module rides the same rails as sec-meta.ts — it reuses `collectTrackedTaskFiles` (the
// git-tracked task-file walk) rather than building a second parser (CLAUDE.md §2.8) — and adds
// four checks:
//   1. two task files share a number (the collision git cannot see);
//   2. an index row resolves to no task file;
//   3. a task file is referenced by no index row;
//   5. two index rows share an id.
// (Leg 4 — "a row's Status disagrees with the file's `**Status:**` line" — was RETIRED by task 188,
//  which collapsed the dual Status store. The file `**Status:**` line is gone; status lives once,
//  in the row, so there is nothing left to drift. The surviving legs keep their original numbers
//  because "leg 5" is a stable cross-file anchor cited by scripts/task-status.mjs + task-new.mjs.)
//
// Check 5 exists because the first cut of this gate did not have it, and review-66 found the hole:
// both row checks keyed on the row's NUMBER, so a phantom `| 61 | … | todo |` row sitting beside
// the real 61 resolved to the real 61's file and was exempt from the orphan check — `_index.md`
// could permanently list a task that does not exist, and the suite stayed green. That state is
// reachable by the repair this defect's own task file calls natural: "resolve the loud index
// conflict, keep both rows". Note what the bug WAS: the comment below claimed "every row resolves
// to exactly one existing file" while the code implemented "every row's number resolves to >=1
// file". The comment was the guard (CLAUDE.md §2.11) — inside the gate built to close a sibling of
// that very class. Row ids are keyed by id, not number, so `27a` != `27b` and the legitimate split
// cannot trip it.
//
// The invariant is deliberately NOT `rowcount == filecount` and NOT a bijection. Task 27 is split
// into TWO rows (`27a`, `27b`) against ONE file (`27-device-gates.md`) — a legitimate 2-rows-to-
// 1-file shape that a naive equality would red on day one, and the "fix" for that would be to
// loosen the gate until it stops complaining (i.e. until it checks nothing). The invariant is:
// each row has a UNIQUE id; every row resolves to exactly one existing file (check 2 catches zero,
// check 1 catches two); every file is referenced by >=1 row. Status is NOT a ledger concern — it
// lives once, in the row (task 188).

/** The ledger file itself. It lives in the same directory as the task files it indexes and MUST
 *  be excluded from the task-file list — counting it as a task file (or globbing a moving target
 *  that matches nothing) is exactly the "silently checks nothing" trap the denominator guards. */
export const INDEX_BASENAME = '_index.md';

/** The five legal Status values (footer of ai-docs/tasks/_index.md). Validating against this set
 *  is also a self-check: a garbage "status" is how a column-shift in the parser would surface. */
export const KNOWN_STATUSES = ['todo', 'in-progress', 'in-review', 'done', 'blocked'] as const;
export type TaskStatus = (typeof KNOWN_STATUSES)[number];
const KNOWN_STATUS_SET: ReadonlySet<string> = new Set(KNOWN_STATUSES);

/** A numbered task file's basename: `NN-slug.md`. One-or-more digits ON PURPOSE — sec-meta.ts's
 *  `OWNER_PATH_PATTERN = /…\d{2}…/` assumes exactly two digits and breaks at task 100; this gate
 *  handles 1-, 2-, and 3-digit numbers so the same bug is not copied here.
 *  Exported so the task 71 single-writer (`scripts/task-status.mjs`) mirrors this grammar rather than
 *  inventing a second one — its `task-status.test.ts` pins the mirror to this exact value (§2.8). */
export const TASK_FILE_BASENAME = /^(\d+)-[\w-]+\.md$/;

/** An index-row id: a number with an optional split suffix (`27a`, `27b`). The number is what
 *  resolves to a file; the suffix distinguishes rows that share one file. Exported for the writer's
 *  pinned mirror (see TASK_FILE_BASENAME). */
export const ROW_ID_PATTERN = /^(\d+)([a-z]*)$/;

interface TaskFileEntry {
  path: string;
  basename: string;
  number: number;
}

interface IndexRow {
  id: string;
  number: number;
  status: string;
}

export interface LedgerAuditInput {
  /** Full text of ai-docs/tasks/_index.md. */
  indexText: string;
  /** Every git-tracked ai-docs/tasks/*.md: path -> text. May include _index.md; it is filtered. */
  taskFiles: Record<string, string>;
}

export interface LedgerAuditResult {
  /** Numbers claimed by more than one task file — the collision git auto-merges clean. */
  duplicateNumbers: string[];
  /** Ids claimed by more than one index row. A dupe hides behind its twin's file: it resolves, so
   *  it is exempt from the orphan and Status checks, and the ledger lists a phantom task. */
  duplicateRows: string[];
  /** Index rows that resolve to no task file. */
  orphanRows: string[];
  /** Task files referenced by no index row. */
  orphanFiles: string[];
  /** Files/rows that could not be parsed: a bad task filename, or an illegal Status value in an
   *  index row. A ledger gate that silently skipped these would be checking less than it claims. */
  unparseable: string[];
  /** What the audit actually compared. Zero anywhere means the gate looked at nothing (T-14). */
  checked: {
    /** Numbered task files parsed (excludes _index.md). */
    taskFiles: number;
    /** Task rows parsed from _index.md. */
    indexRows: number;
    /** Distinct task numbers seen on disk. */
    numbers: number;
  };
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Table cells split on pipes that are NOT backslash-escaped (`\|` is GitHub's table escape). */
const SPLIT_ON_UNESCAPED_PIPE = new RegExp(String.raw`(?<!\\)\|`);
/** Turns the escape back into the literal the author wrote. */
const UNESCAPE_PIPE = new RegExp(String.raw`\\\|`, 'g');

function parseIndexRows(indexText: string, unparseable: string[]): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const line of indexText.split('\n')) {
    if (!line.startsWith('|')) continue;
    // The table is `| id | title | status | depends on |`. A title MAY contain a pipe, escaped as
    // `\|` per GitHub's table spec (row 76 does: "the column holds `'id'\|'en'`"). Splitting on a
    // bare `|` shifts every later cell, so `status` parses as title text — which this gate flagged
    // as a statusMismatch, a true failure with a misleading diagnosis. Split on UNESCAPED pipes
    // only, then unescape. The prior comment claimed "the title never contains a raw pipe": true,
    // irrelevant, and load-bearing on a distinction `.split('|')` cannot make (§2.11).
    const cells = line
      .split(SPLIT_ON_UNESCAPED_PIPE)
      .slice(1, -1)
      .map((cell) => cell.replace(UNESCAPE_PIPE, '|').trim());
    if (cells.length < 3) continue;
    const idCell = cells[0] as string;
    const match = idCell.match(ROW_ID_PATTERN);
    if (!match) continue; // header ("id"), separator ("--"), or a non-task row — not an error.
    const status = cells[2] as string;
    if (!KNOWN_STATUS_SET.has(status)) {
      unparseable.push(
        `${INDEX_BASENAME} row ${idCell} has status "${status}", not one of ${KNOWN_STATUSES.join(', ')}`,
      );
    }
    rows.push({ id: idCell, number: Number(match[1]), status });
  }
  return rows;
}

export function auditLedger(input: LedgerAuditInput): LedgerAuditResult {
  const unparseable: string[] = [];

  // ── task files on disk ───────────────────────────────────────────────────────────────────────
  // Only the filename matters now: task 188 removed the file `**Status:**` line, so a task file's
  // TEXT is no longer read here. The `taskFiles` value is kept in the input shape only so callers
  // (the ledger CLI, the meta-tests) need not change how they gather files.
  const fileEntries: TaskFileEntry[] = [];
  for (const path of Object.keys(input.taskFiles)) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (basename === INDEX_BASENAME) continue; // the ledger is never one of its own rows.
    const match = basename.match(TASK_FILE_BASENAME);
    if (!match) {
      unparseable.push(`${path} is neither ${INDEX_BASENAME} nor a NN-slug.md task file`);
      continue;
    }
    fileEntries.push({ path, basename, number: Number(match[1]) });
  }

  const rows = parseIndexRows(input.indexText, unparseable);

  const filesByNumber = new Map<number, TaskFileEntry[]>();
  for (const entry of fileEntries) pushInto(filesByNumber, entry.number, entry);
  const rowsByNumber = new Map<number, IndexRow[]>();
  for (const row of rows) pushInto(rowsByNumber, row.number, row);

  // 1. two files share a number — the git-invisible collision.
  const duplicateNumbers: string[] = [];
  for (const [number, entries] of filesByNumber) {
    if (entries.length > 1) {
      duplicateNumbers.push(
        `${number} → ${entries
          .map((entry) => entry.basename)
          .sort()
          .join(', ')} (two task files share a number; git auto-merges this clean)`,
      );
    }
  }

  // 5. two rows sharing an id. Keyed on the id, NOT the number: `27a`/`27b` are distinct ids
  //    against one file and must pass, while a second `61` row is a phantom task.
  const rowsById = new Map<string, IndexRow[]>();
  for (const row of rows) pushInto(rowsById, row.id, row);
  const duplicateRows: string[] = [];
  for (const [id, sharing] of rowsById) {
    if (sharing.length > 1) {
      duplicateRows.push(
        `${id} → ${sharing.length} rows share the id "${id}" (statuses: ${sharing
          .map((row) => row.status)
          .join(', ')}); exactly one row per id`,
      );
    }
  }

  // 2. a row that resolves to no file.
  const orphanRows: string[] = [];
  for (const row of rows) {
    if (!filesByNumber.has(row.number)) {
      orphanRows.push(
        `row ${row.id} (status ${row.status}) has no task file numbered ${row.number}`,
      );
    }
  }

  // 3. a file referenced by no row.
  const orphanFiles: string[] = [];
  for (const entry of fileEntries) {
    if (!rowsByNumber.has(entry.number)) {
      orphanFiles.push(`${entry.basename} (number ${entry.number}) has no ${INDEX_BASENAME} row`);
    }
  }

  return {
    duplicateNumbers: duplicateNumbers.sort(),
    duplicateRows: duplicateRows.sort(),
    orphanRows: orphanRows.sort(),
    orphanFiles: orphanFiles.sort(),
    unparseable: unparseable.sort(),
    checked: {
      taskFiles: fileEntries.length,
      indexRows: rows.length,
      numbers: filesByNumber.size,
    },
  };
}

/**
 * The set of task NUMBERS that are DONE in the ledger. A number is done iff at least one index row
 * names it AND every row that names it is `done` — so a split task (`27a`/`27b` → 27) counts as done
 * only when BOTH legs are done (task 188). Exported for sec-meta.ts's staleAllowlist check, which
 * used to read the owning task file's `**Status:**` line; that line no longer exists, so the single
 * source — the index row — answers "is this owner's task done?" instead.
 */
export function doneTaskNumbers(indexText: string): Set<number> {
  const byNumber = new Map<number, IndexRow[]>();
  for (const row of parseIndexRows(indexText, [])) pushInto(byNumber, row.number, row);
  const done = new Set<number>();
  for (const [number, group] of byNumber) {
    if (group.length > 0 && group.every((row) => row.status === 'done')) done.add(number);
  }
  return done;
}
