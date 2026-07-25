// The on-device gate ORCHESTRATION (task 27a/175 deliverable #3). PURE and Node-tested: it takes the
// loaded runners + the runtime facts only a running APK knows and produces the ONE
// `BOLUSI_HARNESS_RESULT` document the driver parses. Keeping `__DEV__` / `HermesInternal` OUT of here
// (the device wrapper run-and-emit.ts injects them) is what lets vitest exercise the resolve logic
// without a device.
//
// TASK 177 (done): `@bolusi/test-support` is device-bundle-safe now — its `/device` subpath carries no
// `node:crypto`, so `registry.ts` (and the at-rest gate body it reaches) bundle into the release APK.
// run-and-emit.ts calls `loadHarness()` and hands the runners here. The gate BODIES are importable; what
// stays unbuilt is the on-device SEAMS each runner needs (the at-rest `AtRestDeviceEnv` real op-sqlite
// seed; the on-device JCS/chaos scenario runners) — 27a Part C, filed as task 178 — so every gate is an
// HONEST skip (§2.11) with a corrected reason (bundle-safety is fixed; the seams are not), never a pass.
import { AT_REST_GATE_ID } from './part-c/at-rest-device-ctx.js';
import type { HarnessRunners } from './registry.js';
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
 * Resolve a result for EVERY required gate from the loaded runners. Task 177 made the gate BODIES
 * importable (`@bolusi/test-support/device` — no `node:crypto`), but the on-device SEAMS they run
 * against are still unbuilt (task 178), so each gate emits an HONEST `skipped` (never a silent pass,
 * §2.11) with a corrected reason — the driver then fails the lane on that id, naming it. `harness` is
 * the `loadHarness()` result: non-null on device (flag on) is proof the device-safe subpath resolved;
 * when task 178 builds the seams, THIS is the single place a runner returns `passed`/`failed`.
 */
export function resolveGateResults(harness: HarnessRunners | null): HarnessGateResult[] {
  return EMULATOR_CORRECTNESS_GATE_IDS.map((id) => skipped(id, skipDetailFor(id, harness)));
}

/** The corrected per-gate skip reason (task 177). Deliberately avoids the driver's shape-error words so
 * a real capture's ONLY failures are the honest skips, not a false schema/shape complaint. */
function skipDetailFor(id: string, harness: HarnessRunners | null): string {
  if (id === AT_REST_GATE_ID) {
    return (
      'the at-rest gate BODY is importable and device-bundle-safe now (task 177 added the ' +
      '@bolusi/test-support/device subpath, which carries no node:crypto, so the release APK ' +
      'assembles). ' +
      (harness === null
        ? 'loadHarness() returned null (flag off — this path does not run in a flagless build). '
        : 'loadHarness() returned the device-safe runners, so the import path resolved on device. ') +
      'What is unbuilt is the on-device AtRestDeviceEnv — seeding the 11 signed-off columns through the ' +
      'real op-sqlite writers plus a cipher-disabled control DB — which is 27a Part C device wiring ' +
      '(task 178). Honest skip (§2.11): the lane reds on this id, never a pass nothing produced.'
    );
  }
  return (
    `no on-device runner is wired for ${id} yet. @bolusi/test-support is device-bundle-safe now ` +
    `(task 177), so the gate bodies are importable; this gate's on-device runner — the shared-engine ` +
    `JCS-vector / reduced-chaos scenario replayed on op-sqlite — is still 27a's unbuilt half (task 178). ` +
    `Honest skip (§2.11): the lane reds on this id, never a silent green.`
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
