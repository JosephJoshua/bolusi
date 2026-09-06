// The ONE host-binding fixture the three device-runner scenarios share (task 200). CHAOS-03/06/07 each
// drive their rig body over a REAL loopback socket the SAME way: boot `startHarnessServer`, mint the run's
// identities from the seed, seed those member pubkeys server-side, build the `net` seam from the socket URL
// + the bearers in mint order, run the rig over `NODE_SEAMS`, then tear BOTH the run's devices and the
// socket/PGlite down in nested `finally`s. That orchestration used to live byte-for-byte in each scenario's
// private `driveRun`; it now lives here once, and each scenario keeps only the knobs that actually differ.
//
// The four divergences are injected, not branched: the boot options (CHAOS-07 boots with a `systemKeyStore`),
// the device-count source (03 reads `options.deviceCount`; 06/07 a fixed `CHAOS0N_DEVICE_COUNT`), an optional
// `afterSeed` host step (CHAOS-07 seeds the tenant's system device between member-seeding and the run), and
// the result `project`ion (03 returns drop/replica figures; 06/07 return `{ verdict, obs }`). `run` and
// `project` are closures the scenario supplies, so this helper never sees a scenario's `Options`/verdict type
// — it owns only the server + identity + net + teardown, which is the whole of the duplication (§2.8, T-7).
//
// This is Node HOST setup, so it lives in `@bolusi/harness` (better-sqlite3 + a token-minting server),
// NEVER in the bundle-safe rig: the on-device gate supplies its own binding of the same rig body.
import type { ConvergenceSeams, FetchLike } from '@bolusi/test-support/chaos';

import { mintIdentities, type RunIdentities } from '../src/identities.js';
import { socketBaseFetch } from '../src/net-server.js';
import { NODE_SEAMS } from '../src/seams-node.js';
import { startHarnessServer, type HarnessServer } from '../src/server.js';

/** The server seam every rig run takes: a `fetch` to the host `@bolusi/server` + one bearer per device in
 *  `mintIdentities` order (index `i` ↔ device `i`). Structurally the `Chaos0NNet` each rig expects. */
export interface DeviceRunNet {
  readonly fetch: FetchLike;
  readonly auth: readonly string[];
}

/** The minimal run handle the fixture needs to guarantee teardown. Every `Chaos0NResult` satisfies it. */
export interface DeviceRunResult {
  close(): Promise<void>;
}

/** The host context an `afterSeed` step reads — the booted server (to seed extra rows) plus the run's minted
 *  identities (CHAOS-07 needs `ids.tenantId` for its system device). */
export interface DeviceRunHost {
  readonly server: HarnessServer;
  readonly ids: RunIdentities;
}

/** The knobs that differ between the three otherwise-identical device-runner host bindings. */
export interface DeviceRunSpec<ResultT extends DeviceRunResult, T> {
  /** The run seed — the single source for BOTH `mintIdentities` and the rig's own re-derivation. */
  readonly seed: number;
  /** How many member devices to mint + seed (03: `options.deviceCount`; 06/07: `CHAOS0N_DEVICE_COUNT`). */
  readonly deviceCount: number;
  /** Boot options forwarded to `startHarnessServer` (CHAOS-07 passes its `systemKeyStore`); omit for none. */
  readonly boot?: Parameters<typeof startHarnessServer>[0];
  /** An extra host step run AFTER the members are seeded and BEFORE the rig runs — CHAOS-07 seeds the
   *  tenant's system device here so the detection pipeline can sign the op device B pulls. Explicitly
   *  `| undefined` so a caller may pass the detection-OFF ternary arm directly (exactOptionalPropertyTypes). */
  afterSeed?: ((host: DeviceRunHost) => Promise<void>) | undefined;
  /** Run the scenario's rig over the built seam — a closure that has baked in its `options`. */
  run(seed: number, seams: ConvergenceSeams, net: DeviceRunNet): Promise<ResultT>;
  /** Evaluate + shape the run's result into the scenario's assertion payload (bakes in `evaluate`/`options`). */
  project(result: ResultT): T;
}

/**
 * Drive one CHAOS device-runner host binding end to end over a real loopback socket (task 198 step 4): boot
 * the server, mint + seed the members, run the optional `afterSeed`, build the `net` seam, run the rig, then
 * `project` the result — tearing BOTH the run's devices and the socket/PGlite down in `finally` whether the
 * run throws or not. The client DB is better-sqlite3 (`NODE_SEAMS`); on device the same rig body binds to
 * op-sqlite (§2.8), so a green here means exactly what a green on device means.
 */
export async function driveDeviceRun<ResultT extends DeviceRunResult, T>(
  spec: DeviceRunSpec<ResultT, T>,
): Promise<T> {
  const running = await startHarnessServer(spec.boot);
  try {
    const ids = mintIdentities(spec.seed, spec.deviceCount);
    const seeded = await Promise.all(ids.devices.map((id) => running.server.seedDevice(id)));

    if (spec.afterSeed !== undefined) {
      await spec.afterSeed({ server: running.server, ids });
    }

    const net: DeviceRunNet = {
      fetch: socketBaseFetch(running.url),
      auth: seeded.map((s) => s.auth),
    };

    const result = await spec.run(spec.seed, NODE_SEAMS, net);
    try {
      return spec.project(result);
    } finally {
      await result.close();
    }
  } finally {
    await running.close();
  }
}
