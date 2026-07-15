// SEC-META-01 machinery (security-guide §2.1.4), kept as pure functions so the meta-test
// can negative-test its own detection logic against fixtures.
//
// Ownership is DECLARED, never inferred from prose. A task file claims the ids it owns on a
// single marker line with a strict grammar (security-guide §2.1.5):
//
//     **SEC ids owned by THIS task:** SEC-RT-01..05, SEC-SECRET-01
//     **SEC ids owned by THIS task:** none
//
// The predecessor read ownership with `taskText.includes(id)` — a *mention*, not a claim — and
// was therefore wrong in both directions: a file naming an id only to DISCLAIM it ("that's task
// 07's") satisfied the check, while a file claiming ids as a range ("SEC-SYNC-01..10", which
// contains no literal `SEC-SYNC-02`) was rejected. Prose cannot express ownership; a grammar can.
import { spawnSync } from 'node:child_process';

export const SEC_ID_PATTERN = /SEC-[A-Z]+-[0-9]+/g;
const OWNER_PATH_PATTERN = /^ai-docs\/tasks\/\d{2}-[\w-]+\.md$/;
/** The ownership marker line. Optional list-bullet and bold markers; value is the rest of the line. */
const OWNERSHIP_MARKER_PATTERN = /^[ \t]*(?:[-*+][ \t]+)?\*\*SEC ids owned by THIS task:\*\*(.*)$/m;
/** One entry of the marker's list: a single id, or an inclusive range like `SEC-SYNC-01..10`. */
const OWNERSHIP_TOKEN_PATTERN = /^SEC-([A-Z]+)-(\d+)(?:\.\.(\d+))?$/;
// First string argument of test()/it()/describe() (incl. .only/.each modifiers — .each is
// curried, so one optional argument group may sit before the title call — and
// template-literal titles). Runs over comment-stripped source: prose such as
// `does NOT title it ("SEC-OPLOG-07 ...")` otherwise matches on the English word "it".
const TEST_TITLE_PATTERN =
  /\b(?:test|it|describe)(?:\.[a-zA-Z]+)*\s*(?:\((?:[^()]|\([^()]*\))*\)\s*)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/**
 * Blank out `//` and block comments, preserving string/template literals and offsets.
 * A SEC id inside a comment must never read as a shipped test title.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        // Keep newlines so line-based tooling and error offsets stay sane.
        out += source[i] === '\n' ? '\n' : '';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Extract verbatim test titles from a test-file source (security-guide §2.1.3). */
export function extractTestTitles(source: string): string[] {
  const titles: string[] = [];
  for (const match of stripComments(source).matchAll(TEST_TITLE_PATTERN)) {
    titles.push(match[2] as string);
  }
  return titles;
}

/**
 * Committed test files only — `git ls-files` keeps the walk inside the git tree
 * (untracked decoys and nested worktrees are invisible).
 */
export function collectTrackedTestFiles(repoRoot: string): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--', '*.test.ts', '*.test.tsx', '*.test.js', '*.test.jsx', '*.test.mjs'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

/** Committed task files — same tracked-only discipline as the test walk. */
export function collectTrackedTaskFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files', '--', 'ai-docs/tasks/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

export type OwnershipDeclaration =
  { kind: 'absent' } | { kind: 'malformed'; detail: string } | { kind: 'declared'; ids: string[] };

/**
 * Parse a task file's ownership marker. Returns `malformed` rather than an empty claim when the
 * grammar is violated: a marker that silently declares nothing would turn an unknown risk into a
 * false assurance (testing-guide T-14).
 */
export function parseOwnedIds(taskText: string): OwnershipDeclaration {
  const marker = taskText.match(OWNERSHIP_MARKER_PATTERN);
  if (!marker) return { kind: 'absent' };

  const value = (marker[1] as string).trim();
  if (value === '') return { kind: 'malformed', detail: '(empty)' };
  if (value === 'none') return { kind: 'declared', ids: [] };

  const ids: string[] = [];
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    const token = entry.match(OWNERSHIP_TOKEN_PATTERN);
    if (!token) return { kind: 'malformed', detail: entry };

    const [, area, startRaw, endRaw] = token as unknown as [string, string, string, string?];
    const width = startRaw.length;
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    if (end < start) return { kind: 'malformed', detail: entry };
    for (let n = start; n <= end; n += 1) {
      ids.push(`SEC-${area}-${String(n).padStart(width, '0')}`);
    }
  }
  return { kind: 'declared', ids: [...new Set(ids)] };
}

export interface SecAuditInput {
  /** Full text of ai-docs/security-guide.md. */
  guideText: string;
  /** Pending allowlist: SEC id → owning ai-docs/tasks/NN-*.md path. */
  allowlist: Record<string, string>;
  /** Verbatim titles of every committed test in the repo. */
  testTitles: string[];
  /** Every committed task file: path → text. */
  taskFiles: Record<string, string>;
}

export interface SecAuditResult {
  /** Ids with neither a verbatim test title nor an allowlist entry. */
  missing: string[];
  /** Allowlist entries whose owning task is done but whose test never shipped. */
  staleAllowlist: string[];
  /** Allowlist entries whose owner path is malformed, missing, or does not DECLARE the id. */
  badOwners: string[];
  /** Allowlist keys that are not ids in the security guide. */
  unknownEntries: string[];
  /** Ids a test titles while the allowlist still calls them owed — the title and the row disagree. */
  titledButPending: string[];
  /** Ids declared by more than one task file. */
  ownershipConflicts: string[];
  /** What the audit actually looked at. Zero anywhere means the gate checked nothing. */
  checked: { ids: number; titles: number; taskFiles: number; declaredIds: number };
}

export function auditSecCoverage(input: SecAuditInput): SecAuditResult {
  const requiredIds = [...new Set(input.guideText.match(SEC_ID_PATTERN) ?? [])].sort();
  const requiredSet = new Set(requiredIds);

  // Ownership index: id → declaring task files. Built from marker lines only.
  const declaredBy = new Map<string, string[]>();
  const malformedMarkers = new Map<string, string>();
  for (const [path, text] of Object.entries(input.taskFiles)) {
    const declaration = parseOwnedIds(text);
    if (declaration.kind === 'malformed') {
      malformedMarkers.set(path, declaration.detail);
      continue;
    }
    if (declaration.kind === 'absent') continue;
    for (const id of declaration.ids) {
      declaredBy.set(id, [...(declaredBy.get(id) ?? []), path]);
    }
  }

  const missing: string[] = [];
  const staleAllowlist: string[] = [];
  const badOwners: string[] = [];
  const titledButPending: string[] = [];

  for (const id of requiredIds) {
    const tested = input.testTitles.some((title) => title.includes(id));
    const owner = input.allowlist[id];

    if (!owner) {
      if (!tested) missing.push(id);
      continue;
    }
    if (tested) {
      // The row says "owed", a shipped title says "done". One of them is lying — and the old gate
      // resolved this by trusting the title, silently retiring the id's unshipped legs.
      titledButPending.push(
        `${id} → ${owner} (a test titles the id, but the row still says it is owed)`,
      );
      continue;
    }
    if (!OWNER_PATH_PATTERN.test(owner)) {
      badOwners.push(`${id} → ${owner} (not an ai-docs/tasks/NN-*.md path)`);
      continue;
    }
    const taskText = input.taskFiles[owner];
    if (taskText === undefined) {
      badOwners.push(`${id} → ${owner} (task file does not exist)`);
      continue;
    }
    const malformed = malformedMarkers.get(owner);
    if (malformed !== undefined) {
      badOwners.push(
        `${id} → ${owner} (malformed "SEC ids owned by THIS task:" marker: expected a comma-separated list of SEC ids/ranges or "none", got "${malformed}")`,
      );
      continue;
    }
    if (!(declaredBy.get(id) ?? []).includes(owner)) {
      badOwners.push(`${id} → ${owner} (no "SEC ids owned by THIS task:" marker declares the id)`);
      continue;
    }
    const status = taskText.match(/\*\*Status:\*\*\s*(\S+)/)?.[1];
    if (status === 'done') {
      staleAllowlist.push(`${id} → ${owner} (task is done but the test never shipped)`);
    }
  }

  const ownershipConflicts = [...declaredBy.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(
      ([id, paths]) =>
        `${id} declared by ${[...paths].sort().join(', ')} (exactly one task must own an id)`,
    )
    .sort();

  const unknownEntries = Object.keys(input.allowlist).filter((id) => !requiredSet.has(id));

  return {
    missing,
    staleAllowlist,
    badOwners,
    unknownEntries,
    titledButPending,
    ownershipConflicts,
    checked: {
      ids: requiredIds.length,
      titles: input.testTitles.length,
      taskFiles: Object.keys(input.taskFiles).length,
      declaredIds: declaredBy.size,
    },
  };
}
