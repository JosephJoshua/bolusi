// Falsification harness for the @bolusi/core crypto guards (CLAUDE.md §2.11 / T-11).
//
// "A guard is only load-bearing if someone has watched it go red." Prose claims that a
// mutant was caught are unauditable — a reviewer cannot re-run a sentence. This script
// makes the falsification a re-runnable artifact: for each guard it BREAKS the source,
// rebuilds, runs the specific test that should catch it, asserts that test now FAILS,
// then restores and rebuilds. A guard whose mutant still passes is reported as a HOLE.
//
// It also encodes the dist-vs-src trap this repo hit: every mutation is followed by
// `tsc -b`, because the tests import @bolusi/core -> dist, so a mutation to src that
// isn't rebuilt would be tested as stale (green for the wrong reason). The `EXIT=` line
// is captured next to every command's output (§2.1).
//
// Run: `pnpm falsify:crypto`  (or `node scripts/falsify-guards.mjs`)
// Safety: each source file is snapshotted in memory and restored in a finally block; a
// final `tsc -b` leaves the tree built. If the process is killed mid-run, restore with
// `git checkout -- packages/core/src`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = 'packages/core/src/crypto';

/**
 * Each mutation names a guard, a unique source anchor to break, the replacement that
 * neuters it, and the test file that MUST go red as a result. `anchor` must occur
 * exactly once in the file so the mutation is unambiguous.
 */
const MUTATIONS = [
  {
    guard: 'JCS whitelist (exotic objects: Set/Map/Date collapse to {})',
    file: `${CORE}/jcs.ts`,
    anchor: 'if (prototype !== Object.prototype && prototype !== null) {',
    mutated: 'if (false) {',
    expectRedIn: 'test/crypto/jcs-guards.test.ts',
  },
  {
    guard: 'JCS own-toJSON descriptor (non-enumerable toJSON collision)',
    file: `${CORE}/jcs.ts`,
    anchor: "if (toJsonDescriptor !== undefined && typeof toJsonDescriptor.value === 'function') {",
    mutated: 'if (false) {',
    expectRedIn: 'test/crypto/jcs-guards.test.ts',
  },
  {
    guard: 'JCS undefined rejection (silent key drop)',
    file: `${CORE}/jcs.ts`,
    // Turn the `undefined` case into a no-op so the value slips through to canonicalize
    // (which would then silently drop the key) — a clean BEHAVIOURAL mutant that the test
    // must catch, not a compile error.
    anchor: "    case 'undefined':\n      throw new JcsInputError(",
    mutated: "    case 'undefined':\n      return;\n      throw new JcsInputError(",
    expectRedIn: 'test/crypto/jcs-guards.test.ts',
  },
  {
    guard: 'base64 non-canonical pad bits (signature malleability)',
    file: `${CORE}/bytes.ts`,
    anchor: 'if ((tailValue & unusedBits) !== 0) {',
    mutated: 'if (false) {',
    expectRedIn: 'test/crypto/bytes.test.ts',
  },
  {
    guard: 'base64 padding-position (interior "=")',
    file: `${CORE}/bytes.ts`,
    anchor: 'if (padding > 2 || !/^=+$/.test(base64.slice(firstPad))) {',
    mutated: 'if (false) {',
    expectRedIn: 'test/crypto/bytes.test.ts',
  },
  {
    guard: 'signOp signs the RAW 32-byte digest, not its hex',
    file: `${CORE}/signed-core.ts`,
    anchor: 'const signature = crypto.sign(hash, secretKey);',
    mutated: 'const signature = crypto.sign(utf8ToBytes(hashHex), secretKey);',
    expectRedIn: 'test/crypto/signed-core.test.ts',
  },
];

/** Run a command, returning { status, output } instead of throwing on non-zero. */
function tryRun(command, args) {
  try {
    const output = execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function build() {
  return tryRun('pnpm', ['exec', 'tsc', '-b']);
}

function runTest(testRelPath) {
  return tryRun('pnpm', ['exec', 'vitest', 'run', join('packages/core', testRelPath)]);
}

let holes = 0;
let checked = 0;
const snapshots = new Map();

// Snapshot every touched file up front so a restore is always possible.
for (const mutation of new Set(MUTATIONS.map((m) => m.file))) {
  snapshots.set(mutation, readFileSync(join(REPO_ROOT, mutation), 'utf8'));
}

try {
  // Baseline: the suite must be green before we can trust a red as "mutation caught".
  console.log('[falsify] baseline build + core tests must be green first...');
  const baseBuild = build();
  if (baseBuild.status !== 0) {
    console.error(`[falsify] baseline build failed EXIT=${baseBuild.status}\n${baseBuild.output}`);
    process.exit(1);
  }
  const baseTest = tryRun('pnpm', ['exec', 'vitest', 'run', 'packages/core']);
  console.log(`[falsify] baseline core tests EXIT=${baseTest.status}`);
  if (baseTest.status !== 0) {
    console.error(`[falsify] baseline is not green; refusing to run\n${baseTest.output}`);
    process.exit(1);
  }

  for (const mutation of MUTATIONS) {
    checked += 1;
    const absolute = join(REPO_ROOT, mutation.file);
    const original = snapshots.get(mutation.file);

    const occurrences = original.split(mutation.anchor).length - 1;
    if (occurrences !== 1) {
      console.error(
        `[falsify] HOLE — anchor for "${mutation.guard}" occurs ${occurrences}x (need exactly 1); mutation is ambiguous`,
      );
      holes += 1;
      continue;
    }

    writeFileSync(absolute, original.replace(mutation.anchor, mutation.mutated));
    const buildResult = build();

    // Only ONE outcome counts as caught: the mutant COMPILED and the test then went RED.
    // Anything else is a HOLE to fix, not a pass.
    let outcome;
    if (buildResult.status !== 0) {
      // A non-compiling mutant ran NO test, so it proves nothing about whether the test
      // detects the behaviour change — "watched the test go red" did not happen. This is
      // the guard-of-the-guard: a falsification harness that scores green on a build
      // error can itself pass without any behavioural failure. Rewrite the mutation so it
      // compiles and changes BEHAVIOUR (e.g. `return` early, `if (false)`, a wrong call),
      // never one that breaks the build.
      outcome = {
        kind: 'HOLE',
        reason: `mutant did NOT COMPILE (build EXIT=${buildResult.status}) — a non-compiling mutant proves nothing about the test; rewrite it to change behaviour`,
      };
    } else {
      const testResult = runTest(mutation.expectRedIn);
      outcome =
        testResult.status !== 0
          ? { kind: 'OK', reason: `${mutation.expectRedIn} went RED EXIT=${testResult.status}` }
          : {
              kind: 'HOLE',
              reason: `${mutation.expectRedIn} stayed GREEN EXIT=0 — the guard is not load-bearing`,
            };
    }

    // Restore before reporting, so a thrown assertion never leaves a mutant on disk.
    writeFileSync(absolute, original);

    if (outcome.kind === 'OK') {
      console.log(`[falsify] OK   ${mutation.guard}\n           mutant caught: ${outcome.reason}`);
    } else {
      holes += 1;
      console.error(`[falsify] HOLE ${mutation.guard}\n           ${outcome.reason}`);
    }
  }
} finally {
  // Guarantee the tree is restored and rebuilt regardless of how the loop ended.
  for (const [file, content] of snapshots) {
    writeFileSync(join(REPO_ROOT, file), content);
  }
  const finalBuild = build();
  console.log(`[falsify] restored all sources; final build EXIT=${finalBuild.status}`);
}

console.log(`\n[falsify] ${checked - holes}/${checked} guards falsified (mutant caught).`);
if (holes > 0) {
  console.error(
    `[falsify] ${holes} HOLE(S) — a guard that cannot be made to fail protects nothing.`,
  );
  process.exit(1);
}
console.log('[falsify] every guard was watched go red and restored to green.');
