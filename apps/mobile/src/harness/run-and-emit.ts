// The device ENTRY that ties deliverable #3 (run gates) to #2 (emit). Reads the runtime facts only a
// running APK knows — the release/debug variant (`__DEV__`) and the bundled Hermes version — assembles
// the honest result via the PURE run.ts, and emits it under the driver's tag. Device-only: it pulls in
// emit.ts (the native module) and RN's `__DEV__` / `HermesInternal` globals, none of which exist in
// Node, so no Node test imports it (the pure pieces it calls ARE Node-tested in harness-run.test.ts).
import { emitHarnessResult } from './emit.js';
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
 * It does NOT call `loadHarness()` (registry.ts): that would import `@bolusi/test-support` into the
 * release bundle, whose barrel pulls `node:crypto` and breaks the APK assemble (task 177). So today
 * `resolveGateResults()` emits an honest all-skipped partial; the real runners land with 177.
 */
export async function runAndEmitHarness(runId: string): Promise<void> {
  const gates = resolveGateResults();
  emitHarnessResult(buildHarnessResult(runId, gates, runtimeFacts()));
}
