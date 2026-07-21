// The hidden Harness screen's flag gate (testing-guide §2.6, 08 §5.5). The whole harness stack —
// Part C runners, the SEC-DEV-06 at-rest probe, the JCS-vector and chaos legs — is REACHABLE only
// when `BOLUSI_TEST_HARNESS=1`, the env the EAS `test` profile sets (and no production profile ever
// does — asserted in test/harness-flag.test.ts). Expo Go cannot run this stack (SQLCipher,
// quick-crypto); it is a release-variant `test`-profile build only.
//
// This is the RUNTIME half of the gate: `loadHarness()` (registry.ts) refuses to hand back any
// runner unless this returns true, so importing the harness module from production still cannot
// reach a runner. The BUILD-time half — the flag living ONLY in the `test` profile — is the eas.json
// static check.

/** True only when the harness flag is set to `'1'` (the EAS `test` profile). */
export function harnessEnabled(): boolean {
  return process.env['BOLUSI_TEST_HARNESS'] === '1';
}

/** The logcat tag the harness emits its one result document under (testing-guide §2.6). Pinned to
 * the same literal `scripts/harness-device.mjs` parses — the wire contract, sourced from §2.6. */
export const HARNESS_RESULT_TAG = 'BOLUSI_HARNESS_RESULT';

/** The result schema id (versioned so a shape change is a visible break). */
export const HARNESS_RESULT_SCHEMA = 'bolusi-harness-result/1';
