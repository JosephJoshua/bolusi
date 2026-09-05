// CHAOS-01's on-device runner (task 181, D24): the multi-device convergence workload (§3.6 / 04 §4.2,
// FR-1118) folded through the REAL `@bolusi/core` engine on the device's Hermes runtime, over op-sqlite
// instead of the Node harness's better-sqlite3. It is the client-only slice D24 landed first — no server
// round-trip (that is CHAOS-03/06/07) — so a single running APK can prove projection order-independence.
//
// ── ONE RIG, TWO BINDINGS (§2.8) ────────────────────────────────────────────────────────────────
// The convergence body — `VirtualDevice`, the canonical-fold oracle, the disorder orchestrator — lives
// in the platform-free shared rig `@bolusi/test-support/chaos` (bundle-safe: no `node:` builtin, proven
// by chaos-bundle-safe.test.ts). The Node harness binds it to better-sqlite3 via `NODE_SEAMS`; THIS file
// is the device binding. Both hand the rig a `ConvergenceSeams` — a DB-engine `openDb` plus the notes
// module trio — so neither the rig nor this file re-implements the fold (T-7).
//
// ── WHY THIS FILE IS PURE (op-sqlite-free) ──────────────────────────────────────────────────────
// The DB engine is INJECTED as `ChaosDbSeams` (a `DbDriverFactory`), exactly as the at-rest env injects
// its driver. run-and-emit.ts — the harness's ONE native-binding site — binds op-sqlite and calls this;
// the host test binds better-sqlite3 (`:memory:`) and proves the runner PASSES on a real fold and REDS on
// its two positive controls (a dropped op → divergence; in-order arrival → INCONCLUSIVE). The only
// emulator-only residual is Hermes-vs-V8 engine behaviour, which the emulator lane exercises.
//
// The bare-client-DB `openDb` + notes trio construction is `buildConvergenceSeams` in
// `./convergence-seams.ts` — shared with the CHAOS-03 runner, so it lives ONCE (§2.8). This file owns
// only the CHAOS-01 verdict (both-fold-paths + convergence), not the DB binding.
import {
  assertBothFoldPaths,
  assertConvergence,
  runConvergence,
  type ConvergenceOptions,
  type ConvergenceResult,
} from '@bolusi/test-support/chaos';

import { describeError, failed, passed, type HarnessGateResult } from '../result.js';
import { buildConvergenceSeams, type ChaosDbSeams } from './convergence-seams.js';

/** The gate id this runner reports under — the CHAOS-01 slot in `EMULATOR_CORRECTNESS_GATE_IDS`. */
export const CHAOS01_GATE_ID = 'CHAOS-01';

// The device DB seam (`ChaosDbSeams`) is defined with its builder in `./convergence-seams.ts`; re-exported
// here so run-and-emit.ts's existing binding import (`./chaos-01-device-env.js`) keeps resolving.
export type { ChaosDbSeams };

/**
 * CHAOS-01's device workload. Smaller than the Node CI scale (500 ops/device, §3.6) so a single low-end
 * Android finishes within the harness budget, but still 3 devices over a shared pool with enough offline
 * edits that every device hits BOTH §4.2 dispatch paths (head-apply AND re-fold) — the both-fold-paths
 * denominator (`assertBothFoldPaths`). The host test PROVES these numbers exercise both paths for the
 * fixed seed below, so a green here can never mean "the run never re-folded".
 */
export const DEFAULT_CHAOS01_OPTIONS: ConvergenceOptions = {
  opsPerDevice: 100,
  deviceCount: 3,
  sharedNotes: 20,
  delivery: 'shuffled',
};

/** A fixed seed so the on-device run is deterministic and reproducible (the PRNG is fully seeded). */
export const DEFAULT_CHAOS01_SEED = 181;

/** The non-fold `ProjectionStats` fields `assertBothFoldPaths` ignores — spread so the per-device
 * snapshot it receives has the full `ProjectionStatsSnapshot` shape (mirrors the Node scenario). */
const EMPTY_STATS_BASE = {
  unregistered: 0,
  rebuilds: 0,
  rebuildBatches: 0,
  rebuildApplies: 0,
} as const;

/**
 * Run the CHAOS-01 convergence workload and return a real verdict (§2.11 — never a silent pass).
 *
 * PASS requires TWO independent guards, exactly as the Node scenario:
 *   1. `assertBothFoldPaths` per device — a run that never re-folded is INCONCLUSIVE, not green (it only
 *      ever saw ops in order, which proves nothing about order-independence);
 *   2. `assertConvergence` — every device's notes-projection digest must equal the canonical-fold
 *      reference, or it throws naming the first differing row.
 * Either guard throwing becomes a RED naming the reason; a throw from the run setup itself is a RED too,
 * never a gap. The host test drives both controls THROUGH this runner (divergence, INCONCLUSIVE) so the
 * reds are watched, not assumed.
 */
export async function runChaos01Gate(
  dbSeams: ChaosDbSeams,
  options: ConvergenceOptions = DEFAULT_CHAOS01_OPTIONS,
  seed: number = DEFAULT_CHAOS01_SEED,
): Promise<HarnessGateResult> {
  const seams = buildConvergenceSeams(dbSeams, 'chaos01');

  let result: ConvergenceResult;
  try {
    result = await runConvergence(seed, options, seams);
  } catch (error) {
    return failed(
      CHAOS01_GATE_ID,
      `CHAOS-01 convergence run threw before producing a verdict — a crash, not a gap (§2.11): ${describeError(error)}`,
    );
  }

  try {
    for (const s of result.stats) {
      assertBothFoldPaths(s.name, {
        ...EMPTY_STATS_BASE,
        headApplies: s.headApplies,
        refolds: s.refolds,
      });
    }
    assertConvergence(result.reference, result.replicas);
  } catch (error) {
    return failed(CHAOS01_GATE_ID, describeError(error));
  } finally {
    await result.close();
  }

  const headApplies = result.stats.reduce((total, s) => total + s.headApplies, 0);
  const refolds = result.stats.reduce((total, s) => total + s.refolds, 0);
  return passed(
    CHAOS01_GATE_ID,
    `${options.deviceCount} devices converged to the canonical-fold reference under shuffled arrival ` +
      `(${result.replicas.length} replicas, ${options.opsPerDevice} ops/device); both §4.2 fold paths ` +
      `fired on every device (${headApplies} head-applies, ${refolds} re-folds).`,
    {
      devices: options.deviceCount,
      opsPerDevice: options.opsPerDevice,
      headApplies,
      refolds,
    },
  );
}
