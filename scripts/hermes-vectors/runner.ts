// SEC-OPLOG-06 vector runner — one program, two runtimes (Node and Hermes).
//
// This is the entry point of the standalone stage-6 bundle (08-stack-and-repo §5.6).
// Imports are deliberately limited to `canonicalize` + core serialization + vector data
// (no zod, no noble, no node:*), so the bundle runs on a bare Hermes VM.
//
// It does two jobs:
//   1. SELF-CHECK — asserts the RFC 8785 vectors on whichever runtime is executing.
//      A Hermes number->string divergence fails HERE, on Hermes.
//   2. EMIT — prints the canonical JCS bytes (as hex) of every fixed vector and of a
//      set of seeded random envelopes, as a deterministic text blob. run.mjs diffs the
//      Node blob against the Hermes blob: identical output IS the byte-equality
//      evidence. Hashing is not needed (and not available on a bare Hermes VM) —
//      comparing the bytes themselves is strictly stronger.
//
// Source-relative imports (not '@bolusi/core') keep the bundle to exactly the modules
// under test; esbuild resolves the .js specifiers to their .ts sources.
import { bytesToHex, utf8ToBytes } from '../../packages/core/src/crypto/bytes.js';
import { canonicalizeJcs, JcsInputError } from '../../packages/core/src/crypto/jcs.js';
import { generateSignedCores } from '../../packages/test-support/src/crypto/envelope-generator.js';
import {
  canonicalizationVectors,
  ieee754HexToNumber,
  numberVectors,
  propertySortingVector,
} from '../../packages/test-support/src/crypto/vectors.js';

// Output is the ONE host capability this runner needs, and the two runtimes disagree on
// it: the Hermes CLI exposes `print` and no `console`; Node exposes `console` and no
// `print`. Both are declared explicitly rather than pulled in from `lib`/`@types/node`,
// because this file compiles under `types: []` (tsconfig.json here) — the same
// platform-free lock the shipped Hermes code obeys. `typeof` on an undeclared
// identifier is safe in JS, so the guards below cannot throw on either runtime.
declare const print: ((message: string) => void) | undefined;
declare const console: { log: (message: string) => void } | undefined;

function emit(message: string): void {
  if (typeof print === 'function') print(message);
  else if (typeof console !== 'undefined') console.log(message);
}

const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(`${label}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const lines: string[] = [];

// --- 1. RFC 8785 Appendix B number serialization -----------------------------------
// The reason this stage exists: JCS number output is the engine's ES number->string.
for (const vector of numberVectors) {
  const value = ieee754HexToNumber(vector.ieee754);

  if (vector.expected === null) {
    let threw = false;
    try {
      canonicalizeJcs(value);
    } catch (error) {
      threw = error instanceof JcsInputError;
    }
    check(`number ${vector.ieee754} must be rejected`, threw, true);
    lines.push(`number\t${vector.ieee754}\tREJECTED`);
    continue;
  }

  const actual = canonicalizeJcs(value);
  check(`number ${vector.ieee754}`, actual, vector.expected);
  lines.push(`number\t${vector.ieee754}\t${actual}`);
}

// --- 2. RFC 8785 §3.2 canonicalization --------------------------------------------
for (const vector of canonicalizationVectors) {
  const canonical = canonicalizeJcs(vector.input as Parameters<typeof canonicalizeJcs>[0]);
  const utf8Hex = bytesToHex(utf8ToBytes(canonical));
  check(`canonicalization ${vector.name}`, canonical, vector.expected);
  check(`canonicalization bytes ${vector.name}`, utf8Hex, vector.expectedUtf8Hex);
  lines.push(`canonical\t${vector.name}\t${utf8Hex}`);
}

// --- 3. RFC 8785 §3.2.3 property sorting (UTF-16 code-unit order) -------------------
{
  const canonical = canonicalizeJcs(propertySortingVector.input);
  const values = [];
  const matches = canonical.match(/:"[^"]*"/g) ?? [];
  for (const match of matches) values.push(match.slice(2, -1));
  check(
    'property sorting order',
    values.join('|'),
    propertySortingVector.expectedValueOrder.join('|'),
  );
  lines.push(`sorting\trfc8785-3.2.3\t${bytesToHex(utf8ToBytes(canonical))}`);
}

// --- 4. Seeded random envelopes ----------------------------------------------------
// Fixed seeds 1..10 (testing-guide §3.3). Nobody hand-picked these envelopes, which is
// what makes cross-runtime agreement here meaningful beyond the curated vectors.
for (let seed = 1; seed <= 10; seed += 1) {
  const cores = generateSignedCores(seed, 20);
  for (let index = 0; index < cores.length; index += 1) {
    const canonical = canonicalizeJcs(
      cores[index] as unknown as Parameters<typeof canonicalizeJcs>[0],
    );
    lines.push(`envelope\t${seed}:${index}\t${bytesToHex(utf8ToBytes(canonical))}`);
  }
}

// --- Output ------------------------------------------------------------------------
if (failures.length > 0) {
  emit(`SEC-OPLOG-06 FAILED (${failures.length}):`);
  for (const failure of failures) emit(failure);
  // A bare Hermes VM has no process.exit; an uncaught throw exits non-zero on both.
  throw new Error(`SEC-OPLOG-06: ${failures.length} vector check(s) failed`);
}

emit(lines.join('\n'));
