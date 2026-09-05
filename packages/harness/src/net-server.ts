// Task 198 step 2/3 host-side glue for the network sync harness. Two tiny, PURE adapters that (a) let
// the existing in-process transports (transport.ts `HttpTransport`, raw-wire.ts `rawPush`) — which POST
// to the fixed absolute `http://harness.test/...` URL — drive the REAL socket `startHarnessServer`
// opens, and (b) describe the OUT-OF-BAND device handoff (the emulator-reachable URL + the raw bearer
// an adb intent extra carries). Owns NO protocol logic (T-7): URL rewriting + record assembly only.
import { baseUrlFetch, type FetchLike } from '@bolusi/test-support/chaos';

import type { RunningHarnessServer, SeededServerDevice } from './server.js';

/**
 * A {@link FetchLike} that points the in-process transports at the REAL socket `startHarnessServer`
 * opens. It delegates to the shared {@link baseUrlFetch} (test-support/chaos), which rewrites the
 * transports' fixed `http://harness.test/<path>` origin to `baseUrl` (preserving path + query) and
 * calls the Node global `fetch`. The rewrite lives ONCE in the bundle-safe rig so the on-device
 * CHAOS-03 net binding shares the same impl (§2.8); this wrapper is only the Node-side name the harness
 * scenarios use to turn `new HttpTransport(socketBaseFetch(running.url), auth)` into a genuine
 * over-the-wire client of the production sync routes (T-7).
 */
export function socketBaseFetch(baseUrl: string): FetchLike {
  return baseUrlFetch(baseUrl);
}

/**
 * The out-of-band handoff an on-device CHAOS runner needs to reach the host `startHarnessServer`
 * (task 198 step 2/3). The bearer is minted host-side by `seedDevice` and delivered OUT OF BAND — via
 * an `adb shell am start … --es` intent extra — NEVER over the sync protocol under test and NEVER
 * baked into the shipping bundle. Both URLs target the host LOOPBACK the server binds: `emulatorUrl`
 * uses the emulator's `10.0.2.2` host-loopback alias; `reverseUrl` is for `adb reverse tcp:P tcp:P`,
 * after which the device reaches the host as `127.0.0.1:P`.
 */
export interface DeviceHandoff {
  /** Host loopback as the Android emulator sees it — `http://10.0.2.2:<port>`. */
  readonly emulatorUrl: string;
  /** Host loopback after `adb reverse tcp:<port> tcp:<port>` — `http://127.0.0.1:<port>`. */
  readonly reverseUrl: string;
  /** The raw `bdt_harness_*` token (no `Bearer ` prefix) for the adb intent extra. */
  readonly bearer: string;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
}

const BEARER_PREFIX = /^Bearer\s+/i;

/**
 * Assemble the {@link DeviceHandoff} from a running server + one seeded device. Pure — it only reads
 * the bound port and strips the `Bearer ` prefix off the seeded auth header; it dispenses no new token.
 */
export function describeDeviceHandoff(
  running: RunningHarnessServer,
  seeded: SeededServerDevice,
): DeviceHandoff {
  return {
    emulatorUrl: `http://10.0.2.2:${running.port}`,
    reverseUrl: `http://127.0.0.1:${running.port}`,
    bearer: seeded.auth.replace(BEARER_PREFIX, ''),
    deviceId: seeded.identity.deviceId,
    tenantId: seeded.identity.tenantId,
    storeId: seeded.identity.storeId,
  };
}
