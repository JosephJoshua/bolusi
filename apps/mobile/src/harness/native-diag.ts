// TEMPORARY (task 201 switcher-hang diagnosis) — a device-only native logcat mirror for the
// session-open boundary logs. Reverted together with a061555/65819f9 once the failing branch is found.
//
// WHY THIS EXISTS SEPARATE FROM `../ports/diagnostics.ts`. A React Native RELEASE build does not flush
// JS `console.warn` to logcat (proven: lane run 34153987393 captured zero `[bolusi]` lines while the
// a061555 instrumentation was live), so the boundary logs were invisible on device. The ONE channel
// that survives release is native `android.util.Log.i(tag, …)` via the `HarnessNative` local Expo
// module — the SAME channel `src/harness/emit.ts` relies on, captured in Maestro's unfiltered
// `device-logcat.txt`. But `diagnostics.ts` sits in dozens of un-mocking Node test graphs, and `expo`'s
// entry runs `async-require/setup` which reads the Metro-only `__DEV__` global → `ReferenceError` at
// test COLLECTION. So the expo import lives HERE, in a file only the device entry (`index.ts`) imports —
// exactly the Node-unreachable pattern that keeps `emit.ts` safe — and is injected into `diagnostics.ts`
// as a sink (`setNativeDiagnosticsMirror`). Node never reaches the import; device gets the proven path.
//
// `requireNativeModule` is imported from `expo` (a direct dep that re-exports it), NOT `expo-modules-core`
// (transitive → TS cannot resolve its types under bundler moduleResolution) — the same call `emit.ts`
// documents. It is called lazily, never at import, so a build that failed to autolink cannot crash boot.
import { requireNativeModule } from 'expo';

interface HarnessNativeModule {
  logResult(tag: string, message: string): number;
}

/** The logcat tag every session-open diagnostic is written under; greppable in the run's artifact. */
const DIAG_LOGCAT_TAG = 'BOLUSI_DIAG';

/**
 * Write one line to logcat under `BOLUSI_DIAG` via native `Log.i`. NEVER throws: a diagnostic must not
 * crash boot, and on a release build there is no other sink to report a failure to anyway. Absence of a
 * line is itself the signal — the unconditional beacons in `index.ts` are the positive control that
 * separates "native channel dead" from "this code path was never reached" (the `HarnessNative` module is
 * present in any APK where `harness:device` passed, so absence points at the capture path, not the module).
 */
export function nativeDiag(line: string): void {
  try {
    requireNativeModule<HarnessNativeModule>('HarnessNative').logResult(DIAG_LOGCAT_TAG, line);
  } catch {
    // Native module unavailable (un-autolinked build / not on device). No release-visible sink exists.
  }
}
