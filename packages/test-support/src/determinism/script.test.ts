import { describe, expect, test } from 'vitest';

import { mulberry32 } from './prng.js';
import { generateScript, RECENCY_WINDOW, type ScriptOp, type ScriptOpKind } from './script.js';

/** A large deterministic script — statistical assertions need a big N (§3.3 "for large N"). */
function bigScript(seed: number): ScriptOp[] {
  return generateScript(mulberry32(seed), {
    opsPerDevice: 2000,
    deviceCount: 3,
  });
}

function countByKind(script: readonly ScriptOp[]): Record<ScriptOpKind, number> {
  const counts: Record<ScriptOpKind, number> = {
    createNote: 0,
    editNoteBody: 0,
    archiveNote: 0,
    mediaAttach: 0,
  };
  for (const op of script) counts[op.kind] += 1;
  return counts;
}

describe('generateScript — deterministic notes workload (testing-guide §3.3)', () => {
  test('emits exactly opsPerDevice ops for each of deviceCount devices', () => {
    const script = generateScript(mulberry32(1), {
      opsPerDevice: 500,
      deviceCount: 3,
    });
    expect(script).toHaveLength(1500);
    for (let d = 0; d < 3; d += 1) {
      expect(script.filter((op) => op.device === d)).toHaveLength(500);
    }
  });

  test('command mix converges to 20/60/15/5 for large N (§3.3)', () => {
    const script = bigScript(42);
    const n = script.length;
    const counts = countByKind(script);
    expect(counts.createNote / n).toBeCloseTo(0.2, 1);
    expect(counts.editNoteBody / n).toBeCloseTo(0.6, 1);
    expect(counts.archiveNote / n).toBeCloseTo(0.15, 1);
    expect(counts.mediaAttach / n).toBeCloseTo(0.05, 1);
    // Tighter than toBeCloseTo(_, 1): each within ±0.02 of target at N=6000 (~3σ).
    expect(Math.abs(counts.createNote / n - 0.2)).toBeLessThan(0.02);
    expect(Math.abs(counts.editNoteBody / n - 0.6)).toBeLessThan(0.02);
    expect(Math.abs(counts.archiveNote / n - 0.15)).toBeLessThan(0.02);
    expect(Math.abs(counts.mediaAttach / n - 0.05)).toBeLessThan(0.02);
  });

  test('every non-create op targets an entity that already exists; createNote assigns the next ordinal', () => {
    const script = bigScript(7);
    let pool = 0;
    for (const op of script) {
      if (op.kind === 'createNote') {
        expect(op.entity).toBe(pool);
        pool += 1;
      } else {
        expect(op.entity).toBeGreaterThanOrEqual(0);
        expect(op.entity).toBeLessThan(pool);
      }
    }
    expect(pool).toBeGreaterThan(0);
  });

  test('target selection is biased toward the 5 most recent entities (forces same-entity contention)', () => {
    const script = bigScript(11);
    let pool = 0;
    let nonCreate = 0;
    let recentHits = 0;
    for (const op of script) {
      if (op.kind === 'createNote') {
        pool += 1;
      } else {
        nonCreate += 1;
        if (op.entity >= pool - RECENCY_WINDOW) recentHits += 1;
      }
    }
    const hitRate = recentHits / nonCreate;
    // Uniform selection over ~1200 entities would hit the last-5 window ~0.4% of the time;
    // the 30% recency bias lifts it to ~0.3. Band proves the bias is real and ~30%, not ~1.
    expect(hitRate).toBeGreaterThan(0.25);
    expect(hitRate).toBeLessThan(0.5);
  });

  test('advances each op by a PRNG-chosen 1–600 s (integer ms)', () => {
    const script = bigScript(3);
    for (const op of script) {
      expect(Number.isInteger(op.clockAdvanceMs)).toBe(true);
      expect(op.clockAdvanceMs).toBeGreaterThanOrEqual(1_000);
      expect(op.clockAdvanceMs).toBeLessThanOrEqual(600_000);
    }
  });

  test('per-op values are unique across the whole script (T-3 — no shared magic constants)', () => {
    const script = bigScript(99);
    const values = script.map((op) => op.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test('the whole script is byte-identical per seed (T-6 determinism)', () => {
    const opts = { opsPerDevice: 800, deviceCount: 4 } as const;
    expect(generateScript(mulberry32(2024), opts)).toEqual(generateScript(mulberry32(2024), opts));
  });

  test('a different seed produces a different script (randomness is real)', () => {
    const opts = { opsPerDevice: 200, deviceCount: 3 } as const;
    expect(generateScript(mulberry32(1), opts)).not.toEqual(generateScript(mulberry32(2), opts));
  });
});
