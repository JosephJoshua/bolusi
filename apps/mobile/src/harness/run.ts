// The on-device gate ORCHESTRATION (task 27a/175 deliverable #3). PURE and Node-tested: it takes the
// loaded runners + the runtime facts only a running APK knows and produces the ONE
// `BOLUSI_HARNESS_RESULT` document the driver parses. Keeping `__DEV__` / `HermesInternal` OUT of here
// (the device wrapper run-and-emit.ts injects them) is what lets vitest exercise the resolve logic
// without a device.
//
// TASK 177 (done): `@bolusi/test-support` is device-bundle-safe now — its `/device` subpath carries no
// `node:crypto`, so `registry.ts` (and the at-rest gate body it reaches) bundle into the release APK.
// run-and-emit.ts calls `loadHarness()` and hands the runners here. The gate BODIES are importable; each
// runner's on-device SEAM is bound in run-and-emit.ts as it lands (at-rest + JCS in task 178; CHAOS-01's
// op-sqlite convergence in task 181). A gate whose seam is NOT yet wired is an HONEST skip (§2.11) with a
// reason naming why (the CHAOS-03/06/07 server round-trip), never a fabricated pass.
import type { HarnessRunners } from './registry.js';
import { HARNESS_RESULT_SCHEMA } from './flag.js';
import { EMULATOR_CORRECTNESS_GATE_IDS } from './gates.js';
import { failed, skipped, type HarnessGateResult, type HarnessResult } from './result.js';

export interface HarnessRuntimeFacts {
  readonly profile: string;
  /** `release` is the only variant the driver accepts (dev-mode JS numbers are meaningless, §2.6). */
  readonly variant: 'release' | 'debug';
  readonly target: 'emulator' | 'device';
  readonly hermesVersion: string;
  /** The git sha the APK was built from (run-and-emit.ts reads EXPO_PUBLIC_BOLUSI_BUILD_SHA). Stamped
   * into the result so the provenance gate can diff the at-rest surface against the ACTUAL build
   * commit, not just the artifact's introducing commit (task 182). `'unknown'` if the env was unset. */
  readonly buildSha: string;
}

/** One on-device gate runner. Returns a real `passed`/`failed` (never `skipped` — an absent runner is
 * how a gate skips). Thrown errors are caught here and turned into a red, so a runner crash on device
 * is a failure the driver names, never a silent gap (§2.11). */
export type GateRunner = () => Promise<HarnessGateResult>;

/** Runners keyed by gate id. run-and-emit.ts (the one device-only site that may bind op-sqlite +
 * expo-file-system) builds these and passes them here — the single wiring seam task 177 left. A gate
 * with no entry skips honestly; the chaos ids deliberately have no entry (see `skipDetailFor`). */
export type DeviceGateRunners = Readonly<Record<string, GateRunner | undefined>>;

/**
 * Resolve a result for EVERY required gate. For each gate id, if `runners` carries a runner AND the
 * harness resolved (flag on), that runner produces the real `passed`/`failed`; otherwise the gate is an
 * HONEST `skipped` (never a silent pass, §2.11) whose reason names why. `harness === null` (flag off)
 * forces every gate to skip regardless of `runners` — the runtime half of the harness lock. A runner
 * that THROWS on device becomes a red naming the id, so a crash is loud, not a gap.
 */
export async function resolveGateResults(
  harness: HarnessRunners | null,
  runners: DeviceGateRunners = {},
): Promise<HarnessGateResult[]> {
  const results: HarnessGateResult[] = [];
  for (const id of EMULATOR_CORRECTNESS_GATE_IDS) {
    const runner = harness === null ? undefined : runners[id];
    if (runner === undefined) {
      results.push(skipped(id, skipDetailFor(id, harness)));
      continue;
    }
    try {
      results.push(await runner());
    } catch (error) {
      results.push(
        failed(
          id,
          `${id} on-device runner THREW instead of returning a verdict — a crash, not a gap (§2.11): ` +
            (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        ),
      );
    }
  }
  return results;
}

/** The chaos ids whose on-device runners are HONESTLY skipped: CHAOS-03/06/07 need a device→host
 * `@bolusi/server` round-trip that has NO producer yet — the harness server is an in-process
 * `app.request` handler (no socket), nothing binds it to a port, no device→host mapping exists, and a
 * synthetic device has no HTTP self-enrollment. Building that host-network transport + the three runners
 * is task 198 (D24 option C's "the device already reaches the host server" premise was falsified at the
 * producer, 2026-09-03). They already PASS on Node against @bolusi/harness. CHAOS-01 is NOT here — its
 * client-only convergence now runs on-device over op-sqlite (task 181), so it is wired in run-and-emit.ts
 * and never reaches this skip set. */
const CHAOS_GATE_IDS: ReadonlySet<string> = new Set(['CHAOS-03', 'CHAOS-06', 'CHAOS-07']);

/** The per-gate skip reason. Deliberately avoids the driver's shape-error words (schema/variant/target/
 * run id) so a real capture's ONLY failures are the honest skips, not a false shape complaint. */
function skipDetailFor(id: string, harness: HarnessRunners | null): string {
  if (harness === null) {
    return (
      `${id} was not run: loadHarness() returned null (EXPO_PUBLIC_BOLUSI_TEST_HARNESS is not "1"), so no ` +
      `on-device runner is reachable in this build. Honest skip (§2.11) — the flag-off path never fabricates a pass.`
    );
  }
  if (CHAOS_GATE_IDS.has(id)) {
    return (
      `${id} has no on-device runner: CHAOS-03/06/07 need a device→host @bolusi/server round-trip that ` +
      `has no producer yet — the harness server is an in-process app.request handler (no socket), nothing ` +
      `binds it to a port, no device→host mapping exists, and a synthetic device has no HTTP enrollment. ` +
      `Building that host-network transport + these three runners is task 198 (CHAOS-01's client-only ` +
      `convergence already runs on-device over op-sqlite, task 181). They already PASS on Node. Honest ` +
      `skip (§2.11): the lane reds on this id, never a fabricated green.`
    );
  }
  return (
    `${id} has no on-device runner wired in this build path. Honest skip (§2.11): the lane reds on this ` +
    `id, never a silent green.`
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
    buildSha: facts.buildSha,
    gates,
  };
}
