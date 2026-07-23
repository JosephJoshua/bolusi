// The flag-gated harness entry (testing-guide §2.6). `loadHarness()` is the ONE door to every Part C
// runner, and it stays SHUT unless `BOLUSI_TEST_HARNESS=1` — so even though production code can
// import this module, it can never reach a runner in a production build. `flag.test.ts` falsifies
// the gate: with the flag unset the door is null; with it set the runners are reachable.
//
// This wires the EMULATOR CORRECTNESS legs (task 27a): the SEC-DEV-06 at-rest gate (with its T-14b
// positive control) and the SEED-200K builder the on-device rebuild / execute-latency runners replay.
// The JCS-vector and reduced-chaos legs run through the shared engines (@bolusi/core / @bolusi/harness
// scenarios UNCHANGED) on device; their gate ids appear in `requiredGateIds` so the driver's parser
// demands them. PERFORMANCE gates are NOT wired here — they are 27b (physical device).
import { generateSeed200k, SEED_200K, type Seed200kSpec } from '@bolusi/test-support';
import { mulberry32, type ScriptOp } from '@bolusi/test-support';

import { harnessEnabled } from './flag.js';
import { runAtRestGate, type AtRestDeviceEnv } from './part-c/at-rest-device-ctx.js';
import type { HarnessGateResult } from './result.js';

/** The correctness gates this emulator lane is responsible for (mirrors `EMULATOR_REQUIRED_GATES` in
 * scripts/harness-device.mjs; both are pinned to the D20 §1 correctness subset). */
export const EMULATOR_CORRECTNESS_GATE_IDS: readonly string[] = Object.freeze([
  'SEC-DEV-06-at-rest',
  'SEC-AUTH-09-leg1',
  'SEC-OPLOG-06-jcs',
  'CHAOS-01',
  'CHAOS-03',
  'CHAOS-06',
  'CHAOS-07',
]);

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
