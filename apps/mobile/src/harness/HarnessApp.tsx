// The React root HarnessActivity renders (component key `BolusiHarness`, registered flag-gated in
// register.ts). On mount it runs the required gates ONCE and emits the single tagged result the driver
// polls for. There is deliberately NOTHING user-visible: this is a test-profile-only screen whose sole
// job is to run and emit to logcat, so it carries no i18n label and no design-system token — the driver
// reads the `BOLUSI_HARNESS_RESULT` logcat line, never the screen. HarnessActivity forwards the driver's
// `--es bolusiHarnessRunId <id>` intent extra as initialProps, so it arrives here as `bolusiHarnessRunId`
// and is echoed back in the result for the driver's freshness check (contract.ts pins the extra key).
import { useEffect, useRef, type ReactElement } from 'react';
import { View } from 'react-native';

import { HARNESS_RUN_ID_EXTRA } from './contract.js';
import { HARNESS_EMIT_FAILED_MARKER } from './emit.js';
import { runAndEmitHarness } from './run-and-emit.js';

/** initialProps are the launching intent's extras (a string bag), delivered by HarnessActivity's
 * `getLaunchOptions()`. The run id is read by the contract key, not a magic name. */
export type HarnessAppProps = Readonly<Record<string, string | undefined>>;

export function HarnessApp(props: HarnessAppProps): ReactElement {
  const runId = props[HARNESS_RUN_ID_EXTRA] ?? '';
  // A guard ref, not state: the run must fire EXACTLY once even under a double-invoke, so a second
  // mount cannot emit a second (duplicate-run-id) result line.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runAndEmitHarness(runId).catch((error: unknown) => {
      // NOT a silent swallow (§2.11 — the catch-that-hid-the-missing-producer class). emit.ts already
      // logged the distinct `BOLUSI_HARNESS_EMIT_FAILED` marker into the unfiltered logcat; this catch
      // keeps a failed emit from surfacing as an unhandled rejection and logs the marker ONCE more so the
      // abort is unmistakable in task 176's failure dump, never the pre-175 silent nothing.
      console.error(
        `${HARNESS_EMIT_FAILED_MARKER}: harness aborted without emitting a result: ${String(error)}`,
      );
    });
  }, [runId]);

  return <View testID="bolusi-harness" />;
}
