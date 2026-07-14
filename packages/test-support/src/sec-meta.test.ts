// SEC-META-01 (security-guide §2.1.4): mechanically enforce "tests ship with the surface".
// Real audit: every SEC id in security-guide.md needs a verbatim test TITLE in a committed
// test file, or a pending-allowlist entry naming its (existing, not-done) owning task file.
// Negative tests below prove the detection logic cannot be satisfied by comments, untracked
// files, or dangling allowlist entries.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { auditSecCoverage, collectTrackedTestFiles, extractTestTitles } from './sec-meta.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function loadAllowlist(): Record<string, string> {
  const allowlist: Record<string, string> = JSON.parse(
    readFileSync(new URL('./sec-pending-allowlist.json', import.meta.url), 'utf8'),
  );
  delete allowlist['$comment'];
  return allowlist;
}

test('SEC-META-01 every security-guide SEC id has a verbatim test title or a pending-task allowlist entry', () => {
  const guideText = readFileSync(join(REPO_ROOT, 'ai-docs/security-guide.md'), 'utf8');
  const testTitles = collectTrackedTestFiles(REPO_ROOT).flatMap((file) =>
    extractTestTitles(readFileSync(join(REPO_ROOT, file), 'utf8')),
  );

  const result = auditSecCoverage({
    guideText,
    allowlist: loadAllowlist(),
    testTitles,
    readTaskFile: (path) => {
      try {
        return readFileSync(join(REPO_ROOT, path), 'utf8');
      } catch {
        return null;
      }
    },
  });

  expect(result.missing, 'SEC ids with neither a test title nor an allowlist entry').toEqual([]);
  expect(result.staleAllowlist, 'allowlist entries pointing at done tasks').toEqual([]);
  expect(result.badOwners, 'allowlist entries with invalid owning-task files').toEqual([]);
  expect(result.unknownEntries, 'allowlist entries not present in security-guide.md').toEqual([]);
});

test('a SEC id mentioned only in a comment or fixture string is NOT counted as tested', () => {
  const source = [
    '// SEC-FAKE-01 mentioned in a comment must not count',
    "const fixture = 'SEC-FAKE-01 in a plain string must not count';",
    "test('some unrelated behavior', () => {});",
  ].join('\n');
  const titles = extractTestTitles(source);
  expect(titles).toEqual(['some unrelated behavior']);

  const result = auditSecCoverage({
    guideText: 'requires SEC-FAKE-01',
    allowlist: {},
    testTitles: titles,
    readTaskFile: () => null,
  });
  expect(result.missing).toEqual(['SEC-FAKE-01']);
});

test('title extraction covers test/it/describe with modifiers and template literals', () => {
  const source = [
    "it.only('SEC-FAKE-02 via it.only', () => {});",
    'describe(`SEC-FAKE-03 via template`, () => {});',
    'test.each([[1]])("SEC-FAKE-04 via each", () => {});',
  ].join('\n');
  expect(extractTestTitles(source)).toEqual([
    'SEC-FAKE-02 via it.only',
    'SEC-FAKE-03 via template',
    'SEC-FAKE-04 via each',
  ]);
});

test('untracked decoy test files are invisible to the committed-file walk', () => {
  const decoyPath = join(REPO_ROOT, 'packages/test-support/src/__decoy-untracked.test.ts');
  writeFileSync(decoyPath, "test('SEC-DECOY-99 planted title', () => {});\n");
  try {
    const tracked = collectTrackedTestFiles(REPO_ROOT);
    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked.some((file) => file.includes('__decoy-untracked'))).toBe(false);
  } finally {
    unlinkSync(decoyPath);
  }
});

test('allowlist entries with missing, malformed, or silent owner task files fail the audit', () => {
  const guideText = 'SEC-FAKE-05 SEC-FAKE-06 SEC-FAKE-07';
  const result = auditSecCoverage({
    guideText,
    allowlist: {
      'SEC-FAKE-05': 'ai-docs/tasks/99-nonexistent.md',
      'SEC-FAKE-06': 'somewhere/else.md',
      'SEC-FAKE-07': 'ai-docs/tasks/02-schemas.md',
    },
    testTitles: [],
    readTaskFile: (path) =>
      path === 'ai-docs/tasks/02-schemas.md' ? '**Status:** todo\nno id mentioned here' : null,
  });
  expect(result.badOwners).toEqual([
    'SEC-FAKE-05 → ai-docs/tasks/99-nonexistent.md (task file does not exist)',
    'SEC-FAKE-06 → somewhere/else.md (not an ai-docs/tasks/NN-*.md path)',
    'SEC-FAKE-07 → ai-docs/tasks/02-schemas.md (task file never mentions the id)',
  ]);
});

test('an allowlist entry whose owning task is done counts as stale', () => {
  const result = auditSecCoverage({
    guideText: 'SEC-FAKE-08',
    allowlist: { 'SEC-FAKE-08': 'ai-docs/tasks/02-schemas.md' },
    testTitles: [],
    readTaskFile: () => '**Status:** done\nSEC-FAKE-08 belongs here',
  });
  expect(result.staleAllowlist).toEqual([
    'SEC-FAKE-08 → ai-docs/tasks/02-schemas.md (task is done but the test never shipped)',
  ]);
});
