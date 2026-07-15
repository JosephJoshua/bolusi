// CI stage 6 — SEC-OPLOG-06: run the JCS vector bundle on Node AND on a real Hermes VM
// and require byte-identical output (08-stack-and-repo §5.6; security-guide SEC-OPLOG-06).
//
// The evidence chain, end to end:
//   1. esbuild bundles runner.ts standalone (canonicalize + core serialization + vector
//      data only — no zod, no noble, no node:*), targeting ES2015 for Hermes.
//   2. hermesc from the RN-PINNED `hermes-compiler` package compiles the bundle. This is
//      the exact compiler RN 0.86 uses, so a syntax/feature the shipped toolchain would
//      reject fails here.
//   3. The bundle executes on Node and on the Hermes VM. Each run SELF-CHECKS the RFC
//      8785 vectors on its own runtime, then prints the canonical JCS bytes.
//   4. The two outputs are compared byte-for-byte. Identical output is the proof that
//      "client JCS bytes === server JCS bytes" (SEC-OPLOG-06) rather than an assumption.
//
// Nothing here may fake step 4: if either run fails, or the outputs differ, this exits
// non-zero and prints the first divergence.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureHermes, HERMES_RELEASE } from './fetch-hermes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
// Emit into dist/: already ignored by the root .gitignore and the eslint config.
const OUT_DIR = join(HERE, 'dist');

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`\n[stage6] FAILED: ${message}\n`);
  process.exit(1);
}

/** hermesc from the npm package RN 0.86 depends on — the RN-pinned compiler. */
function findHermesc() {
  const pkg = require.resolve('hermes-compiler/package.json', { paths: [REPO_ROOT] });
  const binary = join(dirname(pkg), 'hermesc', 'linux64-bin', 'hermesc');
  return existsSync(binary) ? binary : null;
}

mkdirSync(OUT_DIR, { recursive: true });

// --- 1. Bundle ---------------------------------------------------------------------
const bundlePath = join(OUT_DIR, 'jcs-vectors.js');
console.log('[stage6] bundling runner.ts (standalone, Hermes-safe)...');
execFileSync(
  require.resolve('esbuild/bin/esbuild', { paths: [REPO_ROOT] }),
  [
    join(HERE, 'runner.ts'),
    '--bundle',
    // Hermes is not a Node/browser platform: no process, no require, no globals shim.
    '--platform=neutral',
    // ES2015 is the floor both runtimes share. (esbuild cannot downlevel const/class
    // below this, so a lower target is not an option; the v0.13.0 VM instead gets
    // -Xes6-class below. The RN-pinned hermesc accepts this bundle's classes natively.)
    '--target=es2015',
    '--format=iife',
    '--legal-comments=none',
    `--outfile=${bundlePath}`,
  ],
  { stdio: 'inherit', cwd: REPO_ROOT },
);

// --- 2. Compile with the RN-pinned hermesc ------------------------------------------
const hermesc = findHermesc();
if (hermesc) {
  console.log('[stage6] compiling with the RN-pinned hermesc (hermes-compiler)...');
  execFileSync(hermesc, ['-emit-binary', '-out', join(OUT_DIR, 'jcs-vectors.hbc'), bundlePath], {
    stdio: 'inherit',
  });
  console.log('[stage6]   hermesc accepted the bundle.');
} else {
  fail(
    'hermesc not found in hermes-compiler — cannot verify the RN-pinned toolchain accepts the bundle',
  );
}

// --- 3. Execute on both runtimes -----------------------------------------------------
function run(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

console.log('[stage6] running the vector bundle on Node...');
const nodeOutput = run('node', process.execPath, [bundlePath]);

const hermes = ensureHermes();
console.log(`[stage6] running the vector bundle on the Hermes VM (${HERMES_RELEASE.version})...`);
// -Xes6-class: the v0.13.0 host VM is older than the Hermes RN 0.86 ships and parses ES6
// classes only behind this flag. It affects SYNTAX acceptance only — number->string
// serialization, the thing under test, is untouched by it.
const hermesOutput = run('hermes', hermes, ['-Xes6-class', bundlePath]);

// --- 4. Byte-for-byte comparison -----------------------------------------------------
const nodeLines = nodeOutput.trimEnd().split('\n');
const hermesLines = hermesOutput.trimEnd().split('\n');

if (nodeLines.length === 0 || nodeLines[0] === '') {
  fail('the Node run produced no vector output');
}

if (nodeOutput.trimEnd() !== hermesOutput.trimEnd()) {
  const max = Math.max(nodeLines.length, hermesLines.length);
  for (let i = 0; i < max; i += 1) {
    if (nodeLines[i] !== hermesLines[i]) {
      fail(
        `SEC-OPLOG-06: Node and Hermes JCS output diverge at line ${i + 1}\n` +
          `  node  : ${nodeLines[i] ?? '<missing>'}\n` +
          `  hermes: ${hermesLines[i] ?? '<missing>'}`,
      );
    }
  }
  fail('SEC-OPLOG-06: Node and Hermes output differ');
}

console.log(
  `\n[stage6] SEC-OPLOG-06 PASS — ${nodeLines.length} vector lines byte-identical on ` +
    `Node ${process.versions.node} and Hermes ${HERMES_RELEASE.version}.`,
);
console.log('[stage6]   (the RN-pinned hermesc also compiled the bundle)');
