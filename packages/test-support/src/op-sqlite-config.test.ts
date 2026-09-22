/**
 * The `op-sqlite` config block must be where BOTH native build systems look (task 151).
 *
 * THE DEFECT THIS CLOSES. op-sqlite's two build systems each walk UP from their own location and take
 * the FIRST `package.json` they find — same rule, different starting points, and under pnpm they land
 * in different places:
 *
 *   • `android/build.gradle` starts at `$rootDir/../` and reaches `apps/mobile/package.json`.
 *   • `op-sqlite.podspec` starts inside `node_modules/.pnpm/…/op-sqlite` and, because pnpm's store
 *     has no intermediate `package.json`, bottoms out at the REPO ROOT.
 *
 * Observed on a real CI run (task 151's evidence), one run, two lanes:
 *   android: `Detected op-sqlite config from package.json at: …/apps/mobile/android/../package.json`
 *   ios:     `Configuration found at /Users/runner/work/bolusi/bolusi/package.json` → `using pure SQLite`
 *
 * The block lived ONLY at `apps/mobile/package.json`, so iOS silently dropped it. That is how
 * `sqlcipher` was lost on iOS before D22 removed it, and `performanceMode: true` was being lost the
 * same way — with no error, only a log line nobody reads.
 *
 * So the block is MIRRORED, and this asserts the mirror stays honest. A mirror without a guard is the
 * drift shape the 2026-07-26 audit documented; the guard is what makes it safe to have two copies of
 * a value neither build system can be taught to share.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function opSqliteBlock(relativePath: string): unknown {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
  return parsed['op-sqlite'];
}

/** Where each build system's upward walk lands (see the header). */
const ANDROID_DISCOVERS = 'apps/mobile/package.json';
const IOS_DISCOVERS = 'package.json';

test('the android build system finds an op-sqlite config block', () => {
  expect(opSqliteBlock(ANDROID_DISCOVERS)).toBeDefined();
});

test('the ios build system finds an op-sqlite config block', () => {
  // The half that was missing: without a block here, the podspec logs "using pure SQLite" and every
  // setting in the block — today `performanceMode` — is silently dropped from the iOS build.
  expect(opSqliteBlock(IOS_DISCOVERS)).toBeDefined();
});

test('both build systems find the SAME op-sqlite config', () => {
  // The point of the guard. Two copies exist only because the two walks cannot be made to agree;
  // letting them drift would give the platforms different database builds, which is precisely the
  // class of difference that produced the original iOS/Android split.
  expect(opSqliteBlock(IOS_DISCOVERS)).toEqual(opSqliteBlock(ANDROID_DISCOVERS));
});

test('the shared config still pins performanceMode', () => {
  // A denominator check: the two could agree by both being `{}`, which would satisfy the equality
  // above while pinning nothing. `performanceMode` is the D6 setting this block exists to carry.
  expect(opSqliteBlock(ANDROID_DISCOVERS)).toMatchObject({ performanceMode: true });
});
