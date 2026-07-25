// The device ENTRY that ties deliverable #3 (run gates) to #2 (emit). Reads the runtime facts only a
// running APK knows — the release/debug variant (`__DEV__`) and the bundled Hermes version — assembles
// the honest result via the PURE run.ts, and emits it under the driver's tag. Device-only: it pulls in
// emit.ts (the native module) and RN's `__DEV__` / `HermesInternal` globals, none of which exist in
// Node, so no Node test imports it (the pure pieces it calls ARE Node-tested in harness-run.test.ts).
import { emitHarnessResult } from './emit.js';
import { loadHarness } from './registry.js';
import { buildHarnessResult, resolveGateResults, type HarnessRuntimeFacts } from './run.js';

declare const __DEV__: boolean;

interface HermesRuntime {
  getRuntimeProperties?: () => Record<string, string>;
}

/** The Hermes engine the shipping APK bundles (D13). Best-effort — the driver reports it, not gates on it. */
function hermesVersion(): string {
  const hermes = (globalThis as unknown as { HermesInternal?: HermesRuntime }).HermesInternal;
  return hermes?.getRuntimeProperties?.()['OSS Release Version'] ?? 'unknown';
}

function runtimeFacts(): HarnessRuntimeFacts {
  return {
    profile: 'test',
    // The driver REQUIRES `release`. A debug build reports `debug` HONESTLY and the driver rejects it —
    // never a mislabelled release, so a dev-mode capture cannot masquerade as an acceptance run.
    variant: __DEV__ ? 'debug' : 'release',
    // This producer serves the `android-emulator` CI job (the AVD). 27b (physical device) owns the
    // `device` label; nothing on THIS lane touches hardware, so the label names the lane, not an assumed
    // device number (D12/D20 §1).
    target: 'emulator',
    hermesVersion: hermesVersion(),
  };
}

/**
 * Run the required gates and emit the single tagged result. Called ONCE from HarnessActivity's React
 * root (HarnessApp). `runId` is the driver's `--es bolusiHarnessRunId` value; it is echoed back so the
 * driver's freshness check matches. An empty/absent run id is emitted honestly and the driver's
 * run-id check then fails the lane — a mislabelled capture, never a silent pass.
 *
 * It DOES call `loadHarness()` (registry.ts) now (task 177). That value import is what pulls
 * `@bolusi/test-support/device` into the release bundle — the device-bundle-safe subpath that carries no
 * `node:crypto`, so `expo export --platform android` assembles (the OLD barrel here fails Metro on
 * `node:crypto`, which is the falsification task 177 records). The runners are reachable; the on-device
 * SEAMS they need (the at-rest op-sqlite env, the JCS/chaos scenario runners) are 27a Part C / task 178,
 * so `resolveGateResults(harness)` still emits an HONEST all-skipped partial with corrected reasons —
 * bundle-safety is fixed, the seams are not — never a silent pass (§2.11).
 */
export async function runAndEmitHarness(runId: string): Promise<void> {
  const harness = loadHarness();
  const gates = resolveGateResults(harness);
  emitHarnessResult(buildHarnessResult(runId, gates, runtimeFacts()));
}
