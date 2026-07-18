// CHAOS-01 — out-of-order arrival, projection convergence (testing-guide §3.6 / 04 §4.2, FR-1118).
//
// 3 devices author OFFLINE, then every device receives every other device's ops in a PRNG-shuffled
// arrival order and folds them through the REAL engine. PASS: all device digests == the
// canonical-fold reference (§3.4). The run MUST hit both §4.2 dispatch paths (head-apply AND
// re-fold) or fail as INCONCLUSIVE — a convergence "pass" that only ever saw ops in order proves
// nothing about order-independence (the load-bearing trick of the whole engine).
//
// Falsification (§2.11), shipped as positive controls below: a dropped op DIVERGES (the convergence
// guard goes red), and a run whose re-fold counter is 0 fails INCONCLUSIVE (the both-fold-paths
// guard goes red). Both were watched red before this file was believed.
import { describe, expect, test } from 'vitest';

import {
  assertBothFoldPaths,
  assertConvergence,
  CI_VOLUMES,
  resolveSeeds,
  withSeed,
} from '../src/index.js';
import { runConvergence } from '../src/convergence.js';

const OPS_PER_DEVICE = CI_VOLUMES.outOfOrderOpsPerDevice; // 500 (§3.6)
const DEVICE_COUNT = 3;
// A wide shared pool: every note is still edited by multiple devices (same-entity contention), but
// spreading ~1,275 edits across the pool keeps each entity's re-fold history short (04 §4.2).
const SHARED_NOTES = 120;

const emptyStatsBase = {
  unregistered: 0,
  rebuilds: 0,
  rebuildBatches: 0,
  rebuildApplies: 0,
} as const;

describe('CHAOS-01 out-of-order arrival', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-01 convergence across shuffled arrival [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const result = await runConvergence(seed, {
            opsPerDevice: OPS_PER_DEVICE,
            deviceCount: DEVICE_COUNT,
            sharedNotes: SHARED_NOTES,
            delivery: 'shuffled',
          });
          try {
            // Both §4.2 paths must have fired on every device, or the run is inconclusive.
            for (const s of result.stats) {
              assertBothFoldPaths(s.name, {
                ...emptyStatsBase,
                headApplies: s.headApplies,
                refolds: s.refolds,
              });
            }
            // Convergence: every device == the canonical-fold reference.
            assertConvergence(result.reference, result.replicas);
            expect(result.replicas).toHaveLength(DEVICE_COUNT);
          } finally {
            await result.close();
          }
        },
        'CHAOS-01',
      );
    });
  }

  test('CHAOS-01 positive control: a dropped op DIVERGES (convergence guard is load-bearing)', async () => {
    const result = await runConvergence(1, {
      opsPerDevice: 80,
      deviceCount: DEVICE_COUNT,
      sharedNotes: SHARED_NOTES,
      delivery: 'shuffled',
      dropFromDevice0: 3, // device 0 never receives 3 foreign ops → its projection cannot converge
    });
    try {
      expect(() => assertConvergence(result.reference, result.replicas)).toThrow(
        /convergence FAILED/,
      );
    } finally {
      await result.close();
    }
  });

  test('CHAOS-01 positive control: a run with refolds=0 fails INCONCLUSIVE (both-fold-paths guard)', () => {
    // The guard must reject a run that never exercised re-fold — otherwise a green convergence that
    // only head-applied would be believed (the exact §2.11 class).
    expect(() =>
      assertBothFoldPaths('degenerate', { ...emptyStatsBase, headApplies: 10, refolds: 0 }),
    ).toThrow(/INCONCLUSIVE/);
    // And a run that DID exercise both paths passes.
    expect(() =>
      assertBothFoldPaths('healthy', { ...emptyStatsBase, headApplies: 10, refolds: 4 }),
    ).not.toThrow();
  });
});
