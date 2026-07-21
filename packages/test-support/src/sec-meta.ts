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
//
// TASK 52 — the same machinery now also gates `01-domain-model.md §10`'s live invariants (I-#),
// per decision D15b (invariants are CONTRACTS, each owed a test; FR-#### ids are PROVENANCE and
// deliberately are not). ONE implementation, two configs (`OwnershipScheme`, CLAUDE.md §2.8): the
// SEC gate reads `security-guide.md` + `sec-pending-allowlist.json`; the invariant gate reads
// `01-domain-model.md §10` + `invariant-pending-allowlist.json` with the marker line
// `**Invariants owned by THIS task:** I-13`. No second gate is built — only a second scheme.
import { spawnSync } from 'node:child_process';

export const SEC_ID_PATTERN = /SEC-[A-Z]+-[0-9]+/g;
const OWNER_PATH_PATTERN = /^ai-docs\/tasks\/\d{2}-[\w-]+\.md$/;
// First string argument of test()/it()/describe() (incl. .only/.each modifiers — .each is
// curried, so one optional argument group may sit before the title call — and
// template-literal titles). Runs over comment-stripped source: prose such as
// `does NOT title it ("SEC-OPLOG-07 ...")` otherwise matches on the English word "it".
const TEST_TITLE_PATTERN =
  /\b(?:test|it|describe)(?:\.[a-zA-Z]+)*\s*(?:\((?:[^()]|\([^()]*\))*\)\s*)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/**
 * Words with which a title admits, in its own text, that it covers only PART of its id:
 * "(server leg)", "client arm", "SEC-AUTH-09 precursor". security-guide §2.1.6 forbids exactly
 * this — "only the task that completes it may embed the ID verbatim" — because SEC-META-01 reads
 * ANY title containing an id as that id being fully shipped.
 *
 * Deliberately NOT in this vocabulary: `fixture`. "…is ACCEPTED (fixture-validity control)" is a
 * common, legitimate idiom across the SEC-OPLOG suite (T-14b's positive controls), and matching it
 * would make the rule fire on correct tests — the fastest way to get a gate routed around.
 */
const PARTIAL_LEG_QUALIFIER = /\b(?:legs?|arms?|precursor|partial)\b/i;

/**
 * Does this title concede that it covers only one leg of the id it names?
 *
 * Word-boundary anchored: `alarm`/`harm` must not read as "arm", `legal` must not read as "leg" —
 * a false positive here is not a nuisance, it is the end of the rule's credibility.
 */
export function isPartialLegTitle(title: string): boolean {
  return PARTIAL_LEG_QUALIFIER.test(title);
}

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

// ── Ownership schemes ────────────────────────────────────────────────────────────────────────
//
// A scheme is the ONLY thing that differs between the SEC gate and the invariant gate. The audit
// loop below is shared verbatim, so the two gates cannot drift in how they read ownership,
// allowlist rows, or partial-leg titles.

export interface OwnershipScheme {
  /** Human noun for a single owned entry, used in the malformed-marker message. */
  readonly entryNoun: string;
  /** The marker-line label (text before the `:` inside the `**…:**` bold run). */
  readonly markerLabel: string;
  /** The compiled marker-line pattern; group 1 is everything after the label. */
  readonly markerPattern: RegExp;
  /** Expand one marker entry (an id or an inclusive range) to its ids, or null if it is malformed. */
  expandToken(entry: string): string[] | null;
  /**
   * Does a test title CLAIM this id? SEC ids are fixed-width so a substring match is unambiguous;
   * invariant ids are not (`I-1` is a substring of `I-13`), so the invariant scheme boundary-checks.
   */
  titleClaims(title: string, id: string): boolean;
}

/** Build the `**<label>:**` marker pattern. Optional list-bullet and bold markers; group 1 = rest of line. */
function makeMarkerPattern(label: string): RegExp {
  return new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?\\*\\*${label}:\\*\\*(.*)$`, 'm');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** SEC ids: `SEC-AREA-NN`, zero-padded, optionally an inclusive range `SEC-AREA-NN..MM`. */
function expandSecToken(entry: string): string[] | null {
  const token = entry.match(/^SEC-([A-Z]+)-(\d+)(?:\.\.(\d+))?$/);
  if (!token) return null;
  const [, area, startRaw, endRaw] = token as unknown as [string, string, string, string?];
  const width = startRaw.length;
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  if (end < start) return null;
  const ids: string[] = [];
  for (let n = start; n <= end; n += 1) {
    ids.push(`SEC-${area}-${String(n).padStart(width, '0')}`);
  }
  return ids;
}

/** Invariant ids: `I-N`, NOT zero-padded, optionally an inclusive range `I-N..M`. */
function expandInvariantToken(entry: string): string[] | null {
  const token = entry.match(/^I-(\d+)(?:\.\.(\d+))?$/);
  if (!token) return null;
  const [, startRaw, endRaw] = token as unknown as [string, string, string?];
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  if (end < start) return null;
  const ids: string[] = [];
  for (let n = start; n <= end; n += 1) {
    ids.push(`I-${n}`);
  }
  return ids;
}

const SEC_MARKER_LABEL = 'SEC ids owned by THIS task';
export const SEC_SCHEME: OwnershipScheme = {
  entryNoun: 'SEC ids/ranges',
  markerLabel: SEC_MARKER_LABEL,
  markerPattern: makeMarkerPattern(SEC_MARKER_LABEL),
  expandToken: expandSecToken,
  // Fixed-width ids: `SEC-AUTH-01` is never a prefix of another id, so `includes` is unambiguous.
  titleClaims: (title, id) => title.includes(id),
};

const INVARIANT_MARKER_LABEL = 'Invariants owned by THIS task';
export const INVARIANT_SCHEME: OwnershipScheme = {
  entryNoun: 'invariant ids/ranges',
  markerLabel: INVARIANT_MARKER_LABEL,
  markerPattern: makeMarkerPattern(INVARIANT_MARKER_LABEL),
  expandToken: expandInvariantToken,
  // `I-1` IS a substring of `I-13`, so a title claiming I-13 must not read as claiming I-1.
  // Boundary-anchored: no word char or hyphen before, no further digit after.
  titleClaims: (title, id) => new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![0-9])`).test(title),
};

export type OwnershipDeclaration =
  { kind: 'absent' } | { kind: 'malformed'; detail: string } | { kind: 'declared'; ids: string[] };

/**
 * Parse a task file's ownership marker under the given scheme. Returns `malformed` rather than an
 * empty claim when the grammar is violated: a marker that silently declares nothing would turn an
 * unknown risk into a false assurance (testing-guide T-14).
 */
export function parseOwnedIds(taskText: string, scheme: OwnershipScheme): OwnershipDeclaration {
  const marker = taskText.match(scheme.markerPattern);
  if (!marker) return { kind: 'absent' };

  const value = (marker[1] as string).trim();
  if (value === '') return { kind: 'malformed', detail: '(empty)' };
  if (value === 'none') return { kind: 'declared', ids: [] };

  const ids: string[] = [];
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    const expanded = scheme.expandToken(entry);
    if (expanded === null) return { kind: 'malformed', detail: entry };
    ids.push(...expanded);
  }
  return { kind: 'declared', ids: [...new Set(ids)] };
}

export interface CoverageAuditInput {
  /** The ids that MUST be owned, already extracted (and ordered) from the spec by the caller. */
  requiredIds: string[];
  /** Pending allowlist: id → owning ai-docs/tasks/NN-*.md path. */
  allowlist: Record<string, string>;
  /** Verbatim titles of every committed test in the repo. */
  testTitles: string[];
  /** Every committed task file: path → text. */
  taskFiles: Record<string, string>;
}

export interface CoverageAuditResult {
  /** Ids with neither a verbatim test title nor an allowlist entry. */
  missing: string[];
  /** Allowlist entries whose owning task is done but whose test never shipped. */
  staleAllowlist: string[];
  /** Allowlist entries whose owner path is malformed, missing, or does not DECLARE the id. */
  badOwners: string[];
  /** Allowlist keys that are not required ids in the spec. */
  unknownEntries: string[];
  /** Ids a test titles while the allowlist still calls them owed — the title and the row disagree. */
  titledButPending: string[];
  /** Ids declared by more than one task file. */
  ownershipConflicts: string[];
  /**
   * Ids retired ONLY by titles that concede they are partial legs, with nothing declaring them.
   * The gate cannot verify an id is fully covered — but it can refuse to let a title that calls
   * ITSELF a leg stand as the sole evidence that the id is whole.
   */
  partialLegTitles: string[];
  /** What the audit actually looked at. Zero anywhere means the gate checked nothing. */
  checked: {
    ids: number;
    titles: number;
    taskFiles: number;
    declaredIds: number;
    /** Ids with ≥1 verbatim title. Zero ⇒ the title walk found nothing and every rule below is vacuous. */
    idsWithTitles: number;
    /** Titles carrying an id AND a partial-leg qualifier. Zero ⇒ the §2.1.6 rule scanned nothing. */
    partialLegQualifiedTitles: number;
  };
}

/**
 * The shared audit. Given a scheme and the required ids, check each id has exactly one owner:
 * either a verbatim test title, or a pending-allowlist row pointing at a task that DECLARES it.
 */
export function auditCoverage(
  scheme: OwnershipScheme,
  input: CoverageAuditInput,
): CoverageAuditResult {
  const requiredIds = input.requiredIds;
  const requiredSet = new Set(requiredIds);

  // Ownership index: id → declaring task files. Built from marker lines only.
  const declaredBy = new Map<string, string[]>();
  const malformedMarkers = new Map<string, string>();
  for (const [path, text] of Object.entries(input.taskFiles)) {
    const declaration = parseOwnedIds(text, scheme);
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
  const partialLegTitles: string[] = [];

  /** id → the verbatim titles claiming it. */
  const titlesById = new Map<string, string[]>(
    requiredIds.map((id) => [
      id,
      input.testTitles.filter((title) => scheme.titleClaims(title, id)),
    ]),
  );

  // ── §2.1.6: a partial leg must not title an id ───────────────────────────────────────────────
  //
  // task 31 left this open ("Can a partial-coverage title still claim an id? Yes — when no row
  // exists"), reasoning that retiring an id needs title→task attribution the gate does not have.
  // It does not need attribution. When EVERY title claiming an id calls itself a leg/arm, the
  // titles themselves say no test claims the whole id — and if nothing declares the id either,
  // the id is retired by a claim its own author disowned. That is decidable from the titles.
  //
  // Three escapes, all declarative, none prose (task 31's thesis):
  //   1. an unqualified title — the completing test, per §2.1.6;
  //   2. an allowlist row — the id is openly owed;
  //   3. a `**<owned-by-THIS-task>:**` marker — someone declares the id whole.
  for (const id of requiredIds) {
    const titles = titlesById.get(id) as string[];
    if (titles.length === 0) continue;
    if (!titles.every(isPartialLegTitle)) continue;
    if (input.allowlist[id] !== undefined) continue;
    if (declaredBy.has(id)) continue;
    partialLegTitles.push(
      `${id} → every title claiming it concedes it is a partial leg (${titles
        .map((title) => `"${title}"`)
        .join(', ')}), no allowlist row, and no "${scheme.markerLabel}:" marker declares it — ` +
        `so the id reads as fully shipped on the strength of a title that says it is not`,
    );
  }

  for (const id of requiredIds) {
    const tested = (titlesById.get(id) as string[]).length > 0;
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
        `${id} → ${owner} (malformed "${scheme.markerLabel}:" marker: expected a comma-separated list of ${scheme.entryNoun} or "none", got "${malformed}")`,
      );
      continue;
    }
    if (!(declaredBy.get(id) ?? []).includes(owner)) {
      badOwners.push(`${id} → ${owner} (no "${scheme.markerLabel}:" marker declares the id)`);
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
    partialLegTitles: partialLegTitles.sort(),
    checked: {
      ids: requiredIds.length,
      titles: input.testTitles.length,
      taskFiles: Object.keys(input.taskFiles).length,
      declaredIds: declaredBy.size,
      idsWithTitles: [...titlesById.values()].filter((titles) => titles.length > 0).length,
      partialLegQualifiedTitles: [...titlesById.values()]
        .flat()
        .filter((title) => isPartialLegTitle(title)).length,
    },
  };
}

// ── SEC gate (security-guide §2.1.4) ─────────────────────────────────────────────────────────

/** Back-compat alias — the SEC result shape is the shared coverage result. */
export type SecAuditResult = CoverageAuditResult;

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

export function auditSecCoverage(input: SecAuditInput): SecAuditResult {
  const requiredIds = [...new Set(input.guideText.match(SEC_ID_PATTERN) ?? [])].sort();
  return auditCoverage(SEC_SCHEME, {
    requiredIds,
    allowlist: input.allowlist,
    testTitles: input.testTitles,
    taskFiles: input.taskFiles,
  });
}

// ── Invariant gate (01-domain-model.md §10; decision D15b) ───────────────────────────────────

export interface InvariantRow {
  /** The invariant id, e.g. `I-3`. */
  id: string;
  /** True when the row is explicitly retired (its absence from coverage is correct — e.g. I-12). */
  retired: boolean;
}

/**
 * Parse the numbered invariants out of `01-domain-model.md §10` ("Invariants (testable,
 * numbered)"). Reads ONLY that section's table so stray `I-#` references elsewhere in the doc are
 * never counted, and flags retired rows so the live denominator excludes them (T-14). An empty
 * result means the parse matched NOTHING — the caller must fail loudly rather than pass green.
 */
export function parseInvariants(domainModelText: string): InvariantRow[] {
  const section = domainModelText.match(/^## 10\.[^\n]*\n([\s\S]*?)(?=^## )/m);
  if (!section) return [];
  const rows: InvariantRow[] = [];
  for (const line of (section[1] as string).split('\n')) {
    // `| I-N | <description cell> | …`. Capture the description cell (no pipes) for the
    // retired check; any trailing columns (e.g. an owner column) are ignored.
    const cells = line.match(/^\|\s*(I-\d+)\s*\|\s*([^|]*?)\s*\|/);
    if (!cells) continue;
    const [, id, description] = cells as unknown as [string, string, string];
    rows.push({ id, retired: /^retired\b/i.test(description) });
  }
  return rows;
}

/** The live invariant ids (retired rows excluded), in numeric order. */
export function liveInvariantIds(domainModelText: string): string[] {
  return parseInvariants(domainModelText)
    .filter((row) => !row.retired)
    .map((row) => row.id)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

export interface InvariantAuditInput {
  /** Full text of ai-docs/01-domain-model.md. */
  domainModelText: string;
  /** Pending allowlist: invariant id → owning ai-docs/tasks/NN-*.md path. */
  allowlist: Record<string, string>;
  /** Verbatim titles of every committed test in the repo. */
  testTitles: string[];
  /** Every committed task file: path → text. */
  taskFiles: Record<string, string>;
}

export function auditInvariantCoverage(input: InvariantAuditInput): CoverageAuditResult {
  return auditCoverage(INVARIANT_SCHEME, {
    requiredIds: liveInvariantIds(input.domainModelText),
    allowlist: input.allowlist,
    testTitles: input.testTitles,
    taskFiles: input.taskFiles,
  });
}
