// Fetch the Hermes host VM used by CI stage 6 (08-stack-and-repo §5.6, §7 record 6).
//
// WHY A STANDALONE CLI RELEASE AND NOT "THE VM RN SHIPS":
// React Native 0.86 pins Hermes via sdks/.hermesversion = `hermes-v0.17.0`. That git tag
// EXISTS in facebook/hermes but carries NO release assets, and the `hermes-compiler` npm
// package RN depends on ships `hermesc` (a COMPILER) for linux64/osx/win64 and no host
// VM at all. Facebook publishes host VM binaries only as tagged CLI releases, the newest
// of which is v0.13.0. So there is no prebuilt host VM matching the RN-pinned Hermes;
// obtaining one means either building Hermes from source at the tag, or running the
// suite on an Android emulator against RN's libhermes.so.
//
// Stage 6 therefore executes the vectors on a REAL Hermes VM (v0.13.0) on every PR, and
// the exact-version proof runs on the real device in L6 / stage 12 (task 27), which
// testing-guide §2.1 already requires ("re-run redundantly inside L6"). See 08 §7.
//
// The archive is sha256-pinned — same discipline as the gitleaks binary (SEC-SECRET-02).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '.hermes');

/** facebook/hermes v0.13.0 hermes-cli-linux.tar.gz — sha256 verified at task 03. */
export const HERMES_RELEASE = {
  version: 'v0.13.0',
  url: 'https://github.com/facebook/hermes/releases/download/v0.13.0/hermes-cli-linux.tar.gz',
  sha256: 'aead6eb0b8f563bb022354352eae32dad96c933330b6c1941b6db17674ca68ae',
};

/** Absolute path to the `hermes` binary, downloading it once if needed. */
export function ensureHermes() {
  const binary = join(CACHE_DIR, 'hermes');
  if (existsSync(binary)) return binary;

  mkdirSync(CACHE_DIR, { recursive: true });
  const archive = join(CACHE_DIR, 'hermes-cli.tar.gz');

  console.log(`[hermes] downloading ${HERMES_RELEASE.version}...`);
  execFileSync('curl', ['-sSL', '--fail', '-o', archive, HERMES_RELEASE.url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (actual !== HERMES_RELEASE.sha256) {
    rmSync(archive, { force: true });
    throw new Error(
      `[hermes] checksum mismatch\n  expected: ${HERMES_RELEASE.sha256}\n  actual:   ${actual}`,
    );
  }

  // Archive entries are './hermes', './hermesc', ... — extract just the VM.
  execFileSync('tar', ['xzf', archive, '-C', CACHE_DIR, './hermes'], { stdio: 'inherit' });
  rmSync(archive, { force: true });

  writeFileSync(join(CACHE_DIR, '.gitignore'), '*\n');
  console.log(`[hermes] ready: ${binary}`);
  return binary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(ensureHermes());
}
