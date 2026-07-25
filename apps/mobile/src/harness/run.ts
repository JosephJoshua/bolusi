// The on-device gate ORCHESTRATION (task 27a/175 deliverable #3). PURE and Node-tested: it takes the
// runtime facts only a running APK knows and produces the ONE `BOLUSI_HARNESS_RESULT` document the
// driver parses. Keeping `__DEV__` / `HermesInternal` OUT of here (the device wrapper run-and-emit.ts
// injects them) is what lets vitest exercise the honest-partial logic without a device.
//
// IMPORTANT (task 177): the gate ids come from the dependency-free `gates.js`, NOT `registry.js`. The
// real runners (`loadHarness()` → SEED-200K + at-rest) live in registry.ts, which imports
// `@bolusi/test-support`, whose barrel pulls `node:crypto` — unbundleable for a device build. So the
// device path names the gates here and skips them honestly; wiring the runners is blocked on 177.
import { HARNESS_RESULT_SCHEMA } from './flag.js';
import { EMULATOR_CORRECTNESS_GATE_IDS } from './gates.js';
import { skipped, type HarnessGateResult, type HarnessResult } from './result.js';

export interface HarnessRuntimeFacts {
  readonly profile: string;
  /** `release` is the only variant the driver accepts (dev-mode JS numbers are meaningless, §2.6). */
  readonly variant: 'release' | 'debug';
  readonly target: 'emulator' | 'device';
  readonly hermesVersion: string;
}

/**
 * Resolve a result for EVERY required gate. Today NO gate has an on-device runner: the runners need
 * `@bolusi/test-support`, which is not device-bundle-safe (task 177), so each gate emits an honest
 * `skipped` (never a silent pass, §2.11) — the driver then fails the lane on that id, naming it. So the
 * emulator lane's first real run is an honest partial ("gate X is skipped: blocked on 177"), not a
 * green-for-nothing. When 177 lands, this is the single seam where a runner returns `passed`/`failed`.
 */
export function resolveGateResults(): HarnessGateResult[] {
  return EMULATOR_CORRECTNESS_GATE_IDS.map((id) =>
    skipped(
      id,
      'no on-device runner is wired yet. Task 175 landed the producer plumbing (EXPO_PUBLIC flag → ' +
        'HarnessActivity → this JS harness → native tagged emit); the gate BODIES need ' +
        '@bolusi/test-support (SEED-200K + at-rest), which is not device-bundle-safe — its barrel ' +
        'pulls node:crypto, unresolvable by Metro (task 177). This is an HONEST partial: the driver ' +
        'fails the lane on this skipped id rather than reporting a pass nothing produced (§2.11).',
    ),
  );
}

/** Assemble the single result document from resolved gates + the injected runtime facts. */
export function buildHarnessResult(
  runId: string,
  gates: readonly HarnessGateResult[],
  facts: HarnessRuntimeFacts,
): HarnessResult {
  return {
    schema: HARNESS_RESULT_SCHEMA,
    runId,
    profile: facts.profile,
    variant: facts.variant,
    target: facts.target,
    hermesVersion: facts.hermesVersion,
    gates,
  };
}
