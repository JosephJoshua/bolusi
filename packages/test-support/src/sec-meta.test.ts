// SEC-META-01 (security-guide §2.1.4): mechanically enforce "tests ship with the surface".
// Parses security-guide.md for SEC ids; each id needs either a verbatim-id test title in the
// repo or a pending-allowlist entry naming its owning (not-done) task file.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const ID_PATTERN = /SEC-[A-Z]+-[0-9]+/g;
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|js|jsx|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.expo', 'ai-docs', 'android', 'ios']);

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectTestFiles(join(dir, entry.name), out);
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

test('SEC-META-01 every security-guide SEC id has a verbatim test or a pending-task allowlist entry', () => {
  const guide = readFileSync(join(REPO_ROOT, 'ai-docs/security-guide.md'), 'utf8');
  const requiredIds = [...new Set(guide.match(ID_PATTERN) ?? [])].sort();
  expect(requiredIds.length).toBeGreaterThan(0);

  const allowlist: Record<string, string> = JSON.parse(
    readFileSync(new URL('./sec-pending-allowlist.json', import.meta.url), 'utf8'),
  );
  delete allowlist['$comment'];

  const testFileContents = collectTestFiles(REPO_ROOT).map((file) => readFileSync(file, 'utf8'));

  const missing: string[] = [];
  const staleAllowlist: string[] = [];

  for (const id of requiredIds) {
    const tested = testFileContents.some((content) => content.includes(id));
    if (tested) continue;

    const owningTask = allowlist[id];
    if (!owningTask) {
      missing.push(id);
      continue;
    }
    const taskFile = readFileSync(join(REPO_ROOT, owningTask), 'utf8');
    const status = taskFile.match(/\*\*Status:\*\*\s*(\S+)/)?.[1];
    if (status === 'done') {
      staleAllowlist.push(`${id} → ${owningTask} (task is done but the test never shipped)`);
    }
  }

  expect(missing, 'SEC ids with neither a test nor an allowlist entry').toEqual([]);
  expect(staleAllowlist, 'allowlist entries pointing at done tasks').toEqual([]);

  // Guard the allowlist itself: every entry must name a real id from the guide.
  const requiredSet = new Set(requiredIds);
  const unknownEntries = Object.keys(allowlist).filter((id) => !requiredSet.has(id));
  expect(unknownEntries, 'allowlist entries not present in security-guide.md').toEqual([]);
});
