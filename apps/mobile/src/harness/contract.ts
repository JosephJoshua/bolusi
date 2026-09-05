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
 * The ONE intent-extra key carrying every net-backed chaos scenario's host handoff as a JSON map, one
 * entry per scenario (task 198):
 *   `{"chaos03":{"baseUrl":"http://127.0.0.1:<p>","bearers":["bdt_harness_…",…]},"chaos06":{…},"chaos07":{…}}`
 * The base URL is the emulator-reachable origin of that scenario's host `@bolusi/server`
 * (`http://10.0.2.2:<port>` or `http://127.0.0.1:<port>` after `adb reverse`); `bearers` are the per-device
 * raw tokens in device order (no `Bearer ` prefix — `parseChaosNet` rebuilds the header). The driver mints
 * this OUT OF BAND (`am start … --es bolusiHarnessChaosNets <json>`) — NEVER over the sync protocol under
 * test. A scenario absent/malformed in the map → that gate skips honestly (a token-minting server URL is a
 * test-only handoff, never baked into a shipping bundle). One extra, not one-per-scenario, so the intent
 * surface stays a fixed width as scenarios grow.
 */
export const HARNESS_CHAOS_NET_EXTRA = 'bolusiHarnessChaosNets';

/** initialProps as HarnessActivity delivers them — the launching intent's extras, a string bag keyed by
 * the extra literals above. The single source for the props shape HarnessApp renders with and
 * run-and-emit.ts reads the run id + CHAOS-03/06/07 net handoff out of. */
export type HarnessLaunchProps = Readonly<Record<string, string | undefined>>;
