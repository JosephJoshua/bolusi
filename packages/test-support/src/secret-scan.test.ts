// SEC-SECRET-02 (security-guide §10): the secret scanner used by the mandatory pre-commit
// hook and the CI job provably catches a planted credential. The fixture is generated at
// runtime (never committed) and assembled from fragments so this source file itself can
// never match a scanner rule.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'vitest';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scan(dir: string) {
  const result = spawnSync('gitleaks', ['dir', dir, '--no-banner', '--exit-code', '1'], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(
      `gitleaks is not runnable (${result.error.message}) — the secret scan is mandatory (security-guide §10); install https://github.com/gitleaks/gitleaks`,
    );
  }
  return result;
}

test('SEC-SECRET-02 secret scanner exits non-zero on a fixture file containing a fake credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bolusi-secret-fixture-'));
  tempDirs.push(dir);
  // Fake AWS access key id: prefix + 16 uppercase/digit chars, assembled at runtime.
  const fakeAwsKeyId = ['AKIA', 'Q7R2X9WP', 'LM4N6V8B'].join('');
  writeFileSync(join(dir, 'leaky-config.ts'), `export const uploadKey = '${fakeAwsKeyId}';\n`);

  const result = scan(dir);
  expect(result.status).toBe(1);
});

test('SEC-SECRET-02 secret scanner passes a clean fixture (control case)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bolusi-clean-fixture-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'clean-config.ts'), `export const apiTimeoutMs = 5000;\n`);

  const result = scan(dir);
  expect(result.status).toBe(0);
});
