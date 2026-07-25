// The activity ↔ JS wire contract for the on-device harness (task 27a/175). Kept in a dependency-free
// module so BOTH the RN side (register.ts / HarnessApp) and a Node text-scan test of the config plugin
// can pin the SAME literals — a drift here silently renders nothing on device (the §2.11 shape).

/**
 * The `AppRegistry` component key HarnessActivity renders. The generated `HarnessActivity.kt`
 * (plugins/withHarnessActivity) returns this EXACT string from `getMainComponentName()`; a mismatch
 * means the activity boots and finds no component. Asserted against the plugin source in
 * test/harness-activity-plugin.test.ts.
 */
export const HARNESS_COMPONENT_NAME = 'BolusiHarness';

/**
 * The Android intent-extra key the driver passes the run id under (`scripts/harness-device.mjs`:
 * `am start … --es bolusiHarnessRunId <id>`). HarnessActivity forwards `intent.extras` as initialProps,
 * so it arrives on `HarnessApp` as this prop, and the harness echoes it back in the result for the
 * driver's freshness check. Driver, activity, and prop MUST agree on this literal.
 */
export const HARNESS_RUN_ID_EXTRA = 'bolusiHarnessRunId';
