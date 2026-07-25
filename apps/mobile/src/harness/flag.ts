// The hidden Harness screen's flag gate (testing-guide §2.6, 08 §5.5). The whole harness stack —
// Part C runners, the SEC-DEV-06 at-rest probe, the JCS-vector and chaos legs — is REACHABLE only
// when `EXPO_PUBLIC_BOLUSI_TEST_HARNESS=1`, the env the EAS `test` profile sets (and no production
// profile ever does — asserted in test/harness-flag.test.ts). Expo Go cannot run this stack
// (op-sqlite, quick-crypto); it is a release-variant `test`-profile build only.
//
// WHY THE `EXPO_PUBLIC_` PREFIX (task 175 §D). The old name `BOLUSI_TEST_HARNESS` had NO prefix, so
// Metro/Expo never inlined it into the client bundle — at runtime in a release build the expression was
// `undefined === '1'` → `false`, and `loadHarness()` returned `null` forever (the harness stayed shut
// even after a producer existed). Expo inlines ONLY `EXPO_PUBLIC_`-prefixed vars into `process.env` at
// build time. Verified against the actual transform, not assumed: `babel-preset-expo`'s
// `plugins/inline-env-vars.js` rewrites `process.env.<KEY>` for any KEY starting `EXPO_PUBLIC_`, and it
// accepts BOTH member forms — an identifier (`process.env.EXPO_PUBLIC_X`) and a string literal
// (`process.env['EXPO_PUBLIC_X']`) — so the bracket access used here (matching `EXPO_PUBLIC_API_URL` in
// index.ts) is inlined exactly like dot access. `EXPO_NO_CLIENT_ENV_VARS=1` would disable even this; the
// CI lane does not set it. In Node (vitest) this is a plain live-env read, so the tests below still
// mutate it at runtime.
//
// This is the RUNTIME half of the gate: `loadHarness()` (registry.ts) refuses to hand back any
// runner unless this returns true, so importing the harness module from production still cannot
// reach a runner. The BUILD-time half — the flag living ONLY in the `test` profile — is the eas.json
// static check.

/** True only when the harness flag is set to `'1'` (the EAS `test` profile). */
export function harnessEnabled(): boolean {
  return process.env['EXPO_PUBLIC_BOLUSI_TEST_HARNESS'] === '1';
}

/** The logcat tag the harness emits its one result document under (testing-guide §2.6). Pinned to
 * the same literal `scripts/harness-device.mjs` parses — the wire contract, sourced from §2.6. */
export const HARNESS_RESULT_TAG = 'BOLUSI_HARNESS_RESULT';

/** The result schema id (versioned so a shape change is a visible break). */
export const HARNESS_RESULT_SCHEMA = 'bolusi-harness-result/1';
