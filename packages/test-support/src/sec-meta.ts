// SEC-META-01 machinery (security-guide §2.1.4), kept as pure functions so the meta-test
// can negative-test its own detection logic against fixtures.
import { spawnSync } from 'node:child_process';

export const SEC_ID_PATTERN = /SEC-[A-Z]+-[0-9]+/g;
const OWNER_PATH_PATTERN = /^ai-docs\/tasks\/\d{2}-[\w-]+\.md$/;
// First string argument of test()/it()/describe() (incl. .only/.each modifiers — .each is
// curried, so one optional argument group may sit before the title call — and
// template-literal titles). Comments and non-title strings never match.
const TEST_TITLE_PATTERN =
  /\b(?:test|it|describe)(?:\.[a-zA-Z]+)*\s*(?:\((?:[^()]|\([^()]*\))*\)\s*)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Extract verbatim test titles from a test-file source (security-guide §2.1.3). */
export function extractTestTitles(source: string): string[] {
  const titles: string[] = [];
  for (const match of source.matchAll(TEST_TITLE_PATTERN)) {
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

export interface SecAuditInput {
  /** Full text of ai-docs/security-guide.md. */
  guideText: string;
  /** Pending allowlist: SEC id → owning ai-docs/tasks/NN-*.md path. */
  allowlist: Record<string, string>;
  /** Verbatim titles of every committed test in the repo. */
  testTitles: string[];
  /** Returns a task file's text, or null when the path does not exist. */
  readTaskFile: (path: string) => string | null;
}

export interface SecAuditResult {
  /** Ids with neither a verbatim test title nor an allowlist entry. */
  missing: string[];
  /** Allowlist entries whose owning task is done but whose test never shipped. */
  staleAllowlist: string[];
  /** Allowlist entries whose owner path is malformed, missing, or silent about the id. */
  badOwners: string[];
  /** Allowlist keys that are not ids in the security guide. */
  unknownEntries: string[];
}

export function auditSecCoverage(input: SecAuditInput): SecAuditResult {
  const requiredIds = [...new Set(input.guideText.match(SEC_ID_PATTERN) ?? [])].sort();
  const requiredSet = new Set(requiredIds);
  const titleText = input.testTitles;

  const missing: string[] = [];
  const staleAllowlist: string[] = [];
  const badOwners: string[] = [];

  for (const id of requiredIds) {
    const tested = titleText.some((title) => title.includes(id));
    if (tested) continue;

    const owner = input.allowlist[id];
    if (!owner) {
      missing.push(id);
      continue;
    }
    if (!OWNER_PATH_PATTERN.test(owner)) {
      badOwners.push(`${id} → ${owner} (not an ai-docs/tasks/NN-*.md path)`);
      continue;
    }
    const taskText = input.readTaskFile(owner);
    if (taskText === null) {
      badOwners.push(`${id} → ${owner} (task file does not exist)`);
      continue;
    }
    if (!taskText.includes(id)) {
      badOwners.push(`${id} → ${owner} (task file never mentions the id)`);
      continue;
    }
    const status = taskText.match(/\*\*Status:\*\*\s*(\S+)/)?.[1];
    if (status === 'done') {
      staleAllowlist.push(`${id} → ${owner} (task is done but the test never shipped)`);
    }
  }

  const unknownEntries = Object.keys(input.allowlist).filter((id) => !requiredSet.has(id));

  return { missing, staleAllowlist, badOwners, unknownEntries };
}
