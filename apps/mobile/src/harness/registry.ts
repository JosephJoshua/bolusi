// The flag-gated harness entry (testing-guide §2.6). `loadHarness()` is the ONE door to every Part C
// runner, and it stays SHUT unless `EXPO_PUBLIC_BOLUSI_TEST_HARNESS=1` — so even though production code can
// import this module, it can never reach a runner in a production build. `flag.test.ts` falsifies
// the gate: with the flag unset the door is null; with it set the runners are reachable.
//
// This wires the EMULATOR CORRECTNESS legs (task 27a): the SEC-DEV-06 at-rest gate (with its T-14b
// positive control) and the SEED-200K builder the on-device rebuild / execute-latency runners replay.
// The JCS-vector leg (SEC-OPLOG-06) runs on device — it replays the SHARED RFC 8785 vectors through
// `canonicalizeJcs` on Hermes. The reduced-chaos legs (CHAOS-01/03/06/07) do NOT run on device and
// CANNOT here: their scenarios live in `@bolusi/harness` (PGlite + better-sqlite3 `VirtualDevice`),
// which apps/mobile does not bundle, and CHAOS-03/06/07 need a server round-trip a single emulator
// lacks — so they emit an HONEST `skipped` (task 181), and the driver reds the lane on them. All 7
// gate ids appear in `requiredGateIds` so the parser demands each. PERFORMANCE gates are NOT wired
// here — they are 27b (physical device).
import { generateSeed200k, SEED_200K, type Seed200kSpec } from '@bolusi/test-support/device';
import { mulberry32, type ScriptOp } from '@bolusi/test-support/device';

import { harnessEnabled } from './flag.js';
import { EMULATOR_CORRECTNESS_GATE_IDS } from './gates.js';
import { runAtRestGate, type AtRestDeviceEnv } from './part-c/at-rest-device-ctx.js';
import type { HarnessGateResult } from './result.js';

// The correctness gate ids live in the dependency-free `gates.js` (re-exported here for
// `loadHarness().requiredGateIds`) so the device entry can name them without depending on the runner
// machinery. Task 177 made this file itself device-bundle-safe: it imports `@bolusi/test-support/device`
// (the SEED-200K builder + the at-rest gate body), a subpath that carries NO `node:crypto` — so a
// value-import of `registry.ts` from run-and-emit.ts now bundles into the release APK (the OLD barrel
// root would break the Metro assemble on `node:crypto`; that is the 177 falsification).
export { EMULATOR_CORRECTNESS_GATE_IDS };

export interface HarnessRunners {
  /** The SEED-200K composition the rebuild/execute-latency runners replay. */
  readonly seedSpec: Seed200kSpec;
  /** Build the canonical SEED-200K history (seed 42) — the on-device rebuild subject. */
  buildSeed(): ScriptOp[];
  /**
   * Run SEC-DEV-06's at-rest leg (with its positive control) against the real app-layer column
   * cipher. NOT SQLCipher — D22 removed it entirely (task 148); the DB file is plain SQLite by
   * design and only the signed-off columns are sealed (10-db §9.7).
   */
  runAtRest(env: AtRestDeviceEnv): Promise<HarnessGateResult>;
  /** The gate ids the driver's parser requires green. */
  readonly requiredGateIds: readonly string[];
}

/**
 * The harness is UNREACHABLE unless the flag is set. Returns `null` in every non-`test` build, so an
 * accidental import from production wiring resolves to nothing to run.
 */
export function loadHarness(): HarnessRunners | null {
  if (!harnessEnabled()) return null;
  return {
    seedSpec: SEED_200K,
    buildSeed: () => generateSeed200k(mulberry32(42)),
    runAtRest: runAtRestGate,
    requiredGateIds: EMULATOR_CORRECTNESS_GATE_IDS,
  };
}
