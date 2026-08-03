// `pnpm task:new "<title>" [--deps a,b] [--status todo]` (task 173).
//
// WHY THIS EXISTS
// ---------------
// There is a `pnpm task:status` (writes both §2.6 locations atomically) but no `task:new`. To create a
// task an agent read the highest id in a PER-WORKTREE `_index.md` and picked the next — a read that is
// stale the moment two agents file concurrently, which is the NORMAL case in a fan-out phase. That cost
// three id collisions in one session (`162`/`165`, `163`/`166`, and a `>>`-append phantom-129), each a
// renumber-and-re-merge cycle.
//
// WHAT IT DOES / DOES NOT PROMISE (task 173 — state the honest limit in the tool's own output)
// -------------------------------------------------------------------------------------------
// It allocates the id against `origin/main` (∪ the local tree), which removes the DOMINANT cause — a
// stale local base. It does NOT make collisions impossible: two callers who both fetch, both see id N
// as highest, and both pick N+1 before either pushes still collide. That window is small but nonzero,
// and the REAL backstop stays the ledger gate's duplicateRows/duplicateFiles checks (task 66) — which
// caught collision 3. This tool reduces the RATE; the ledger keeps a collision LOUD. Do not weaken it.
//
// The shared filename/status constants come from task-status.mjs so the two task tools cannot disagree
// (§2.8, one source). Importing it is side-effect-free — its CLI is behind an `import.meta.url` guard.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { KNOWN_STATUSES, TASK_FILE_BASENAME, INDEX_BASENAME } from './task-status.mjs';

const TASKS_DIR = 'ai-docs/tasks';
/** A `| id | …` data row's leading id number. Header/separator rows have no digit here, so they miss. */
const INDEX_ROW_ID = /^\|\s*(\d+)[a-z]*\s*\|/;

/**
 * Kebab-case a title into a filename slug: lowercase, non-alphanumerics collapse to single hyphens,
 * trimmed, capped so the path stays sane. Returns '' for a title with no alphanumerics (caller refuses).
 * @param {string} title
 */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Every task-id NUMBER named by an `_index.md`'s data rows (ignores the header/separator). */
export function indexRowIds(indexText) {
  const ids = [];
  for (const line of indexText.split('\n')) {
    const match = INDEX_ROW_ID.exec(line);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

/** Every task-id NUMBER named by a set of `NNN-slug.md` basenames. */
export function basenameIds(basenames) {
  const ids = [];
  for (const basename of basenames) {
    const match = TASK_FILE_BASENAME.exec(basename);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

/** The slug portion of a `NNN-slug.md` basename, or null if it is not a task file. */
function basenameSlug(basename) {
  const match = /^\d+-([\w-]+)\.md$/.exec(basename);
  return match ? match[1] : null;
}

/**
 * Compute the new `_index.md` text and the new task file (path + text) for a `task:new`, WITHOUT
 * writing anything — pure and disk-free so the negative controls unit-test against fixtures, not a
 * broken repo. Returns `{ ok: true, … }` with both texts or `{ ok: false, code, message }` and none.
 *
 * The allocated id is `max(origin ids ∪ local index ids ∪ local file ids) + 1`, so it is fresh against
 * BOTH origin/main and the local tree by construction — and the function ALSO asserts that (a max-plus-
 * one bug must fail loudly, not silently reuse an id).
 *
 * @param {{ localIndexText: string, localBasenames: string[], originIndexText: string,
 *           title: string, deps?: string[], status?: string }} input
 */
export function computeNewTask(input) {
  const { localIndexText, localBasenames, originIndexText, title } = input;
  const status = input.status ?? 'todo';
  const deps = input.deps ?? [];

  if (!KNOWN_STATUSES.includes(status)) {
    return {
      ok: false,
      code: 'BAD_STATUS',
      message: `unknown status "${status}" — expected one of ${KNOWN_STATUSES.join(', ')}`,
    };
  }
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, code: 'BAD_TITLE', message: 'a non-empty task title is required' };
  }
  const slug = slugify(title);
  if (slug === '') {
    return {
      ok: false,
      code: 'BAD_SLUG',
      message: `title "${title}" has no alphanumerics to form a filename slug`,
    };
  }

  const originIds = indexRowIds(originIndexText);
  const localIds = [...indexRowIds(localIndexText), ...basenameIds(localBasenames)];
  const known = new Set([...originIds, ...localIds]);
  if (known.size === 0) {
    // No ids anywhere means the parse read nothing — refuse rather than confidently allocate `1` over
    // a real, populated ledger the parser failed to read (T-14: a zero denominator is a broken parse).
    return {
      ok: false,
      code: 'EMPTY_LEDGER',
      message:
        'parsed ZERO task ids from origin/main AND the local tree — refusing to allocate over a ledger the parse could not read',
    };
  }
  const id = Math.max(...known) + 1;
  if (known.has(id)) {
    return {
      ok: false,
      code: 'ID_TAKEN',
      message: `allocated id ${id} but it already exists (origin/main or local) — the max+1 allocation is broken`,
    };
  }

  const basename = `${id}-${slug}.md`;
  for (const existing of localBasenames) {
    if (existing === basename) {
      return { ok: false, code: 'FILE_EXISTS', message: `${TASKS_DIR}/${basename} already exists` };
    }
    if (basenameSlug(existing) === slug) {
      return {
        ok: false,
        code: 'SLUG_TAKEN',
        message: `slug "${slug}" is already used by ${existing} — choose a more specific title`,
      };
    }
  }

  const depsCell = deps.length > 0 ? deps.join(', ') : '—';
  // Escape any pipe in the title so the 4-column row stays 4 columns (the SPLIT_ON_UNESCAPED_PIPE
  // convention task-status.mjs + ledger.ts both parse by — §2.8).
  const rowTitle = title.trim().replace(/\|/g, '\\|');
  const row = `| ${id} | ${rowTitle} | ${status} | ${depsCell} |`;

  // Insert the row AFTER the last DATA row (last `| <digit>… |` line), i.e. before the blank line and
  // the `**Status values:**` footer — never at end-of-file. Match INDEX_ROW_ID, NOT `startsWith('|')`:
  // the latter also matches the header/separator AND any `|`-leading prose line a footer might carry
  // (a legend sub-table), which would splice the new row INTO the footer and malform the table (173
  // review). A data row is the only line that starts `| <number>`.
  const lines = localIndexText.split('\n');
  let lastRow = -1;
  for (let i = 0; i < lines.length; i++) if (INDEX_ROW_ID.test(lines[i])) lastRow = i;
  if (lastRow === -1) {
    return {
      ok: false,
      code: 'NO_TABLE',
      message: `${INDEX_BASENAME} has no table rows to append after — is this the right file?`,
    };
  }
  const newIndexText = [...lines.slice(0, lastRow + 1), row, ...lines.slice(lastRow + 1)].join(
    '\n',
  );

  const depsLine = deps.length > 0 ? deps.join(', ') : '—';
  const fileText = [
    `# TASK ${id} — ${title.trim()}`,
    '',
    `**Status:** ${status}`,
    `**Depends on:** ${depsLine}`,
    '**Blocks:** —',
    '**SEC ids owned by THIS task:** none.',
    '',
    '## Goal',
    '_TODO: describe the deliverable, acceptance, and the §2.11 falsification._',
    '',
  ].join('\n');

  return {
    ok: true,
    id,
    slug,
    basename,
    filePath: `${TASKS_DIR}/${basename}`,
    fileText,
    indexText: newIndexText,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Parse `"<title>" [--deps a,b] [--status s]`. Title is the first non-flag arg. */
function parseArgs(argv) {
  let title;
  let deps = [];
  let status = 'todo';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--deps') {
      deps = (argv[++i] ?? '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
    } else if (arg === '--status') {
      status = argv[++i] ?? status;
    } else if (title === undefined) {
      title = arg;
    }
  }
  return { title, deps, status };
}

/** origin/main's `_index.md`, after a best-effort fetch. Warns (never dies) if the network is down. */
function readOriginIndex() {
  try {
    execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch {
    console.error(
      'task:new: WARNING could not `git fetch origin main` (offline?) — allocating against the LAST-FETCHED origin/main; a fresh fetch is what makes the id current.',
    );
  }
  try {
    return execFileSync('git', ['show', `origin/main:${TASKS_DIR}/${INDEX_BASENAME}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch {
    console.error(
      'task:new: WARNING no origin/main ref for the index — allocating against the LOCAL tree only, which is exactly the stale-base race this tool exists to reduce.',
    );
    return '';
  }
}

function runCli(argv) {
  const { title, deps, status } = parseArgs(argv);
  if (!title) {
    console.error('usage: pnpm task:new "<title>" [--deps a,b] [--status todo]');
    console.error(`  <status> one of: ${KNOWN_STATUSES.join(', ')} (default todo)`);
    return 2;
  }

  const dir = join(REPO_ROOT, TASKS_DIR);
  const localIndexText = readFileSync(join(dir, INDEX_BASENAME), 'utf8');
  const localBasenames = readdirSync(dir).filter((b) => b.endsWith('.md') && b !== INDEX_BASENAME);
  const originIndexText = readOriginIndex();

  const result = computeNewTask({
    localIndexText,
    localBasenames,
    originIndexText,
    title,
    deps,
    status,
  });
  if (!result.ok) {
    console.error(`task:new: ${result.message}`);
    return 1;
  }

  const filePath = join(REPO_ROOT, result.filePath);
  if (existsSync(filePath)) {
    // Belt-and-suspenders: never clobber an existing file even if the slug/id check missed it.
    console.error(`task:new: ${result.filePath} already exists — refusing to overwrite`);
    return 1;
  }
  const indexPath = join(dir, INDEX_BASENAME);
  // Write the file first, then the index; restore-by-delete-less (there was no file) on an index throw
  // so the two locations never disagree — the same both-or-neither discipline as task:status.
  writeFileSync(filePath, result.fileText);
  try {
    writeFileSync(indexPath, result.indexText);
  } catch (err) {
    // roll back the just-created file so a failed index write leaves no orphan file (ledger red)
    try {
      execFileSync('git', ['clean', '-fq', '--', result.filePath], { cwd: REPO_ROOT });
    } catch {
      /* fall through to the throw; the file may be left for the caller to remove */
    }
    throw err;
  }

  console.log(
    `task:new: created ${result.filePath} + its _index.md row as id ${result.id} (${status}).`,
  );
  console.log(
    `task:new: id allocated against origin/main ∪ local — this REDUCES but does not eliminate collisions; the ledger gate (duplicateRows/duplicateFiles) stays the loud backstop.`,
  );
  console.log(
    `task:new: close the pick→push window now:  git add ${result.filePath} ${TASKS_DIR}/${INDEX_BASENAME} && git commit`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(runCli(process.argv.slice(2)));
}
