// The result EMITTER (task 27a/175 deliverable #2). Writes the ONE result document to Android logcat
// under EXACTLY the tag `scripts/harness-device.mjs` filters on (`adb logcat -d -s
// BOLUSI_HARNESS_RESULT:I`).
//
// WHY NATIVE, NOT `console.log` (task 175 leg 2, the trap recorded at the driver's poll). The driver's
// `-s BOLUSI_HARNESS_RESULT:I` is a **tag** filterspec: logcat drops every line whose TAG is not
// `BOLUSI_HARNESS_RESULT` before the driver reads a byte. A React Native `console.log('BOLUSI_HARNESS_
// RESULT: …')` reaches logcat under the tag `ReactNativeJS`, so the driver's substring grep would match
// it but `-s` deletes the line first — a correct-looking emitter, a correct-looking parser, a permanent
// empty capture. Only `android.util.Log.i(tag, message)` actually SETS the tag. The `HarnessNative`
// local Expo module exposes `logResult(tag, message)` → `Log.i`; its native source is COMMITTED under
// `apps/mobile/modules/harness-native/android/` (a bare `android/` gitignore silently dropped it at first
// — task 175 review), so autolinking compiles it into the APK. The tag is `HARNESS_RESULT_TAG` from
// flag.ts — the SAME literal the driver exports, asserted equal in
// packages/test-support/src/harness-device.test.ts. Emitter and filter are chosen together.
//
// `requireNativeModule` is called LAZILY inside emit(), never at import, so importing this file cannot
// crash a build that failed to autolink the module — and Node (no native runtime) never reaches the
// call because emit.ts is only reachable from the device-only entry (register.ts → HarnessApp).
// Imported from `expo` (a direct dep that re-exports it from expo-modules-core), not `expo-modules-core`
// directly (which is transitive, so TS cannot resolve its types under bundler moduleResolution).
import { requireNativeModule } from 'expo';

import { HARNESS_RESULT_TAG } from './flag.js';
import type { HarnessResult } from './result.js';

interface HarnessNativeModule {
  logResult(tag: string, message: string): number;
}

/**
 * The distinct logcat marker an emit FAILURE writes. Native `Log.i` under the driver's tag is the ONLY
 * path the driver's tag-filtered poll can see; if the native module is missing from the APK (e.g. its
 * source was not committed) or `logResult` throws, the poll sees nothing and the lane times out. This
 * marker — greppable, and tellable-apart from "no result at all" — is written to the UNFILTERED logcat
 * (task 176's failure dump) so the reason is never the pre-175 silent nothing (§2.11).
 */
export const HARNESS_EMIT_FAILED_MARKER = 'BOLUSI_HARNESS_EMIT_FAILED';

/**
 * Emit the single tagged result document to logcat via native `Log.i`. On ANY native failure it does
 * NOT fail silently: it logs `HARNESS_EMIT_FAILED_MARKER` (loud, in the unfiltered dump) and RETHROWS,
 * so no caller can swallow a missing producer into nothing (the §2.11 catch-that-hid-the-bug class).
 */
export function emitHarnessResult(result: HarnessResult): void {
  const json = JSON.stringify(result);
  try {
    const native = requireNativeModule<HarnessNativeModule>('HarnessNative');
    native.logResult(HARNESS_RESULT_TAG, json);
  } catch (error) {
    console.error(
      `${HARNESS_EMIT_FAILED_MARKER}: native HarnessNative.logResult unavailable — the tagged result ` +
        `was NOT written, so the driver's poll will see nothing: ${String(error)}`,
    );
    throw error instanceof Error ? error : new Error(String(error));
  }
}
