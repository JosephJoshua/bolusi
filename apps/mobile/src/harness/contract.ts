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

/**
 * The intent-extra key carrying the emulator-reachable base URL of the host `@bolusi/server`
 * (`http://10.0.2.2:<port>` or `http://127.0.0.1:<port>` after `adb reverse`) for the CHAOS-03 device
 * runner (task 198). The driver mints it OUT OF BAND (`am start … --es bolusiHarnessChaosBaseUrl <url>`)
 * — NEVER over the sync protocol under test. Absent (with its bearers sibling) → CHAOS-03 skips honestly;
 * a token-minting server URL is a test-only handoff, never baked into a shipping bundle.
 */
export const HARNESS_CHAOS_NET_BASE_URL_EXTRA = 'bolusiHarnessChaosBaseUrl';

/**
 * The intent-extra key carrying the per-device raw bearer tokens for CHAOS-03 as a JSON string array
 * (`["bdt_harness_…", …]`, one per synthetic device, in device order — no `Bearer ` prefix; the runner
 * rebuilds the header). Minted host-side by `seedDevice` and delivered OUT OF BAND with the base URL
 * above; the two extras travel together (both present → run CHAOS-03, both absent → honest skip).
 */
export const HARNESS_CHAOS_NET_BEARERS_EXTRA = 'bolusiHarnessChaosBearers';

/** initialProps as HarnessActivity delivers them — the launching intent's extras, a string bag keyed by
 * the extra literals above. The single source for the props shape HarnessApp renders with and
 * run-and-emit.ts reads the run id + CHAOS-03 net handoff out of. */
export type HarnessLaunchProps = Readonly<Record<string, string | undefined>>;
