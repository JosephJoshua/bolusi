// The React root HarnessActivity renders (component key `BolusiHarness`, registered flag-gated in
// register.ts). On mount it runs the required gates ONCE and emits the single tagged result the driver
// polls for. There is deliberately NOTHING user-visible: this is a test-profile-only screen whose sole
// job is to run and emit to logcat, so it carries no i18n label and no design-system token — the driver
// reads the `BOLUSI_HARNESS_RESULT` logcat line, never the screen. HarnessActivity forwards the driver's
// `--es bolusiHarnessRunId <id>` intent extra as initialProps, so it arrives here as `bolusiHarnessRunId`
// and is echoed back in the result for the driver's freshness check (contract.ts pins the extra key).
import { useEffect, useRef, type ReactElement } from 'react';
import { View } from 'react-native';

import type { HarnessLaunchProps } from './contract.js';
import { HARNESS_EMIT_FAILED_MARKER } from './emit.js';
import { runAndEmitHarness } from './run-and-emit.js';

/** initialProps are the launching intent's extras (a string bag), delivered by HarnessActivity's
 * `getLaunchOptions()`. run-and-emit.ts reads the run id + CHAOS-03 net handoff out of it by the contract
 * keys, never a magic name — see contract.ts. */
export type HarnessAppProps = HarnessLaunchProps;

export function HarnessApp(props: HarnessAppProps): ReactElement {
  // A guard ref, not state: the run must fire EXACTLY once even under a double-invoke, so a second mount
  // cannot emit a second (duplicate-run-id) result line. `props` is set once by the launching activity
  // (getLaunchOptions), so listing it in deps cannot re-fire the guarded run.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runAndEmitHarness(props).catch((error: unknown) => {
      // NOT a silent swallow (§2.11 — the catch-that-hid-the-missing-producer class). emit.ts already
      // logged the distinct `BOLUSI_HARNESS_EMIT_FAILED` marker into the unfiltered logcat; this catch
      // keeps a failed emit from surfacing as an unhandled rejection and logs the marker ONCE more so the
      // abort is unmistakable in task 176's failure dump, never the pre-175 silent nothing.
      console.error(
        `${HARNESS_EMIT_FAILED_MARKER}: harness aborted without emitting a result: ${String(error)}`,
      );
    });
  }, [props]);

  return <View testID="bolusi-harness" />;
}
