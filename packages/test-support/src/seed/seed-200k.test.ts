// SEED-200K determinism + composition (testing-guide §4.1). The year-equivalent local history
// the Part C rebuild / execute-latency gates seed on-device (task 27a). These are Node tests that
// run in CI on every PR — no emulator, no device — so the SEED is proven deterministic and
// correctly composed BEFORE any figure is ever measured on it.
//
// Two properties matter and are both here: (1) byte-identity from seed 42 (T-6 — a rebuild time is
// meaningless if the input drifts run to run), and (2) the exact composition §4.1 pins, so a silent
// change to the generator that halves the entity count (and so the rebuild cost) reds this lane
// rather than quietly making a gate easier. The digest is COMPUTED from the generated ops, never a
// hardcoded hex string (a non-42 seed must produce a different one), so the test cannot pass a
// generator that ignores its seed.
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { mulberry32 } from '../determinism/prng.js';
import type { ScriptOp } from '../determinism/script.js';
import { generateSeed200k, SEED_200K } from './seed-200k.js';

/** A byte digest over the whole script — the "byte-identical" oracle (§4.1). Order-sensitive on
 * purpose: two scripts with the same multiset but different ORDER are different histories. */
function digest(script: readonly ScriptOp[]): string {
  const hash = createHash('sha256');
  for (const op of script) {
    hash.update(
      `${op.device}|${op.kind}|${op.entity}|${op.schemaVersion}|${op.clockAdvanceMs}|${op.value}\n`,
    );
  }
  return hash.digest('hex');
}

function countKind(script: readonly ScriptOp[], kind: ScriptOp['kind']): number {
  return script.reduce((n, op) => (op.kind === kind ? n + 1 : n), 0);
}

// Generate the canonical seed once and reuse across the composition assertions — 200k ops is real
// work and there is no reason to pay it per test.
const seed42 = generateSeed200k(mulberry32(42));

describe('SEED-200K — deterministic year-equivalent history (testing-guide §4.1)', () => {
  test('two generations at seed 42 are byte-identical (T-6 determinism)', () => {
    expect(digest(generateSeed200k(mulberry32(42)))).toBe(digest(generateSeed200k(mulberry32(42))));
  });

  test('a non-42 seed produces a different digest — the output is not hardcoded', () => {
    expect(digest(seed42)).not.toBe(digest(generateSeed200k(mulberry32(7))));
    expect(digest(seed42)).not.toBe(digest(generateSeed200k(mulberry32(43))));
  });

  test('emits exactly 200,000 operations', () => {
    expect(seed42).toHaveLength(SEED_200K.totalOps);
    expect(SEED_200K.totalOps).toBe(200_000);
  });

  test('~20,000 entities × ~10 ops each: exactly 20,000 createNote ops', () => {
    expect(countKind(seed42, 'createNote')).toBe(SEED_200K.entityCount);
    expect(SEED_200K.entityCount).toBe(20_000);
    // ~10 ops per entity by construction (200k / 20k).
    expect(SEED_200K.totalOps / SEED_200K.entityCount).toBe(10);
  });

  test('5,000 MediaItem metadata rows: exactly 5,000 mediaAttach ops', () => {
    expect(countKind(seed42, 'mediaAttach')).toBe(SEED_200K.mediaRows);
    expect(SEED_200K.mediaRows).toBe(5_000);
  });

  test('v1→v2 schema cutover EXACTLY at op 100,000 (v1 at 99,999, v2 at 100,000)', () => {
    expect(SEED_200K.cutoverIndex).toBe(100_000);
    expect(seed42[99_999]?.schemaVersion).toBe(1);
    expect(seed42[100_000]?.schemaVersion).toBe(2);
    // And universally, not just at the boundary.
    expect(seed42.every((op, i) => op.schemaVersion === (i < SEED_200K.cutoverIndex ? 1 : 2))).toBe(
      true,
    );
  });

  test('every non-create op targets an entity that already exists (a valid, replayable history)', () => {
    let pool = 0;
    for (const op of seed42) {
      if (op.kind === 'createNote') {
        expect(op.entity).toBe(pool);
        pool += 1;
      } else {
        expect(op.entity).toBeGreaterThanOrEqual(0);
        expect(op.entity).toBeLessThan(pool);
      }
    }
    expect(pool).toBe(SEED_200K.entityCount);
  });

  test('each op advances the clock by a PRNG-chosen 1–600 s (integer ms)', () => {
    for (const op of seed42) {
      expect(Number.isInteger(op.clockAdvanceMs)).toBe(true);
      expect(op.clockAdvanceMs).toBeGreaterThanOrEqual(1_000);
      expect(op.clockAdvanceMs).toBeLessThanOrEqual(600_000);
    }
  });

  test('per-op values are unique across the whole seed (T-3 — no shared magic constants)', () => {
    const values = new Set(seed42.map((op) => op.value));
    expect(values.size).toBe(seed42.length);
  });
});
