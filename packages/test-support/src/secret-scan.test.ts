// SEC-SECRET-02 (security-guide §10): the secret scanner used by the mandatory pre-commit
// hook and the CI job provably catches a planted credential. The fixture is generated at
// runtime (never committed) and assembled from fragments so this source file itself can
// never match a scanner rule.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('SEC-SECRET-02 generated Android app build is excluded but source and nested-worktree code are scanned', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = mkdtempSync(join(repoRoot, '.secret-scan-fixture-'));
  tempDirs.push(dir);
  const generated = join(dir, 'apps/mobile/android/app/build');
  const nestedGenerated = join(dir, '.claude/worktrees/task-test/apps/mobile/android/app/build');
  const appSource = join(dir, 'apps/mobile/src');
  const nestedSource = join(dir, '.claude/worktrees/task-test/apps/mobile/src');
  const nativeModuleSource = join(dir, 'apps/mobile/modules/harness-native/android/src/main/java');
  const unrelatedBuild = join(dir, 'packages/test-support/build');
  for (const path of [
    generated,
    nestedGenerated,
    appSource,
    nestedSource,
    nativeModuleSource,
    unrelatedBuild,
  ]) {
    mkdirSync(path, { recursive: true });
  }

  const fakeAwsKeyId = ['AKIA', 'Q7R2X9WP', 'LM4N6V8B'].join('');
  const generatedFile = join(generated, 'index.android.bundle');
  writeFileSync(generatedFile, `export const uploadKey = "${fakeAwsKeyId}";\n`);
  writeFileSync(
    join(nestedGenerated, 'index.android.bundle'),
    `const uploadKey = "${fakeAwsKeyId}";\n`,
  );

  const args = ['dir', dir, '--no-banner', '--redact=100', '--exit-code', '1'];
  const withoutConfig = spawnSync('gitleaks', args, { encoding: 'utf8' });
  expect(withoutConfig.status).toBe(1);

  const config = join(repoRoot, '.gitleaks.toml');
  const withConfig = () =>
    spawnSync(
      'gitleaks',
      [...args, '--config', config, '--report-format', 'json', '--report-path', '-'],
      { encoding: 'utf8' },
    );
  expect(withConfig().status).toBe(0);

  const sourceFiles = [
    join(appSource, 'leaky-config.ts'),
    join(nestedSource, 'leaky-config.ts'),
    join(nativeModuleSource, 'LeakyConfig.kt'),
    join(unrelatedBuild, 'leaky-config.ts'),
  ];
  for (const file of sourceFiles) {
    writeFileSync(file, `const uploadKey = "${fakeAwsKeyId}";\n`);
  }
  const result = withConfig();
  expect(result.status).toBe(1);
  const findings = JSON.parse(result.stdout) as { File: string; Secret: string }[];
  expect(findings.map((finding) => finding.File).sort()).toEqual(sourceFiles.sort());
  expect(result.stdout + result.stderr).not.toContain(fakeAwsKeyId);
  expect(findings.every((finding) => finding.Secret !== fakeAwsKeyId)).toBe(true);
});
