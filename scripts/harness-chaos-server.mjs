// The CHAOS-03/06/07 HOST server child (task 198 step 4). Spawned by `pnpm harness:device`
// (scripts/harness-device.mjs `startChaosNetServer`) as a SEPARATE Node process, so the real
// `@bolusi/server` (Hono on PGlite) and the TCP sockets it opens OUTLIVE the driver's blocking `adb`
// calls — a server must stay up for the whole logcat poll, which a `spawnSync` in the driver could not
// hold. On boot it stands up THREE production servers, one per net-backed chaos gate, because conflict
// detection is a SERVER-WIDE boot-time gate (on the presence of a `systemKeyStore`): CHAOS-03/06 need it
// OFF and CHAOS-07 needs it ON, so they cannot share one server. For each it:
//   1. starts the production server on host loopback (127.0.0.1, ephemeral port);
//   2. mints that scenario's CANONICAL identities from the shared seed — the SAME identities the
//      on-device runner derives (mintIdentities is a pure fn of the seed; no identity crosses the wire,
//      only the seed agreement does — §2.8 / T-6). CHAOS-07 additionally seeds the tenant's SYSTEM device
//      + registers its signing secret, so the real conflict-detection pipeline can sign the
//      `platform.conflict_detected` op the device pulls and verifies (the device never mints or sees that
//      key — it is deployment-owned host setup, exactly as the member keys are);
//   3. seeds each device server-side and collects its `bdt_harness_*` bearer in MINT ORDER, so device i
//      pairs with `net.auth[i]`;
//   4. rolls all three into ONE handshake line (`formatChaosNetHandshake`) the driver parses for each
//      scenario's bound port + device-reachable base URL + raw bearers.
// Then it stays alive on the open sockets until SIGTERM/SIGINT (the driver's exit handler), tearing every
// server (socket + PGlite) down cleanly.
//
// CRITICAL — SEED PARITY: each scenario seeds at its own `DEFAULT_CHAOS0N_SEED` (NOT the host proofs'
// distinct HOST_SEED), because the on-device runner runs at that default and `mintIdentities` /
// `mintSystemDevice` are pure functions of the seed. Boot at any other seed and the device's derived
// members/system key would not match the seeded rows → every device auth or the system-op verify fails.
//
// RESOLUTION (why the imports are relative, not `@bolusi/harness`): the repo-root `node_modules` carries
// NO `@bolusi/*` workspace link, so a bare package specifier would not resolve for a script that lives
// at the repo root. The built barrel `packages/harness/dist/index.js`, however, resolves its OWN
// transitive `@bolusi/*` from the harness's own `node_modules` (Node resolves a module's imports from
// the module's location, not the entry script's). So this requires the harness + its deps to be BUILT
// (`tsc -b`), which the emulator lane does before `harness:device`. `formatChaosNetHandshake` comes from
// the sibling driver so the child and the driver agree on the wire BY CONSTRUCTION (round-trip pinned in
// packages/harness/scenarios/chaos-net-server-child.test.ts).
import { register } from 'tsx/esm/api';

import {
  DEFAULT_CHAOS03_OPTIONS,
  DEFAULT_CHAOS03_SEED,
  DEFAULT_CHAOS06_SEED,
  CHAOS06_DEVICE_COUNT,
  DEFAULT_CHAOS07_SEED,
  CHAOS07_DEVICE_COUNT,
  describeDeviceHandoff,
  mintIdentities,
  mintSystemDevice,
  startHarnessServer,
  systemSignerKeyStore,
} from '../packages/harness/dist/index.js';

import { formatChaosNetHandshake } from './harness-device.mjs';

// A TS-capable ESM loader, mandatory for this child. `startHarnessServer()` runs the DB migrator
// (packages/db-server/src/migrator.ts), which uses Kysely's `FileMigrationProvider` to dynamically
// `import()` the RAW `.ts` migration files under `packages/db-server/migrations/` — and those import
// `.js` sibling specifiers (NodeNext). A bare `node` child has no way to load `.ts`, so that dynamic
// import dies `ERR_MODULE_NOT_FOUND: Cannot find module '.../schema/security.js' imported from
// .../migrations/0001_roles.ts`, `main()` reds, and the driver reads no handshake. vitest transpiles
// for the host-binding tests; here we register tsx explicitly (the migrator's own doc says "whatever
// imports them needs a TS-capable loader — vitest here, tsx under kysely-ctl"). Use tsx's OWN
// `esm/api` register(), not `node:module`'s register('tsx/esm', …) — tsx rejects the latter with
// "tsx must be loaded with --import instead of --loader" (the deprecated loader path). The bare
// specifier resolves from THIS file's location up to the root `node_modules/tsx` (a root devDep),
// cwd-independent, so it works wherever the driver spawns us. The static imports above are compiled
// `dist/*.js` and need no loader; only the runtime migration `import()` inside `startHarnessServer` does,
// and it runs after this call — falsify by deleting this line: the child dies with the ERR_MODULE_NOT_FOUND
// above and the child-boot scenario reds.
register();

/**
 * Boot one production server + seed one scenario's canonical devices, returning the running server and
 * its handshake fragment (`{ port, baseUrl, bearers }`). `describeDeviceHandoff` strips the `Bearer `
 * prefix (the device's parseChaosNet re-adds it) and single-sources the 127.0.0.1 base-URL format
 * (net-server.ts, §2.8). When `detection` is set (CHAOS-07 only), boots WITH the tenant's systemKeyStore
 * and seeds the matching system device + secret, so the conflict-detection pipeline signs the
 * `platform.conflict_detected` op with a key the pulling device verifies — byte-identical to the host
 * proof (device-runner-chaos-07.test.ts), except seeded at DEFAULT_CHAOS07_SEED (the device's seed).
 *
 * Records the server in `servers` the instant it is created — BEFORE seeding — so a seed failure mid-boot
 * (or a SIGTERM arriving during the boot window) still releases the socket via `shutdown`.
 */
async function bootScenario(servers, seed, deviceCount, { detection = false } = {}) {
  const systemSecrets = new Map();
  const running = await startHarnessServer(
    detection ? { systemKeyStore: systemSignerKeyStore(systemSecrets) } : undefined,
  );
  servers.push(running);

  const ids = mintIdentities(seed, deviceCount);
  const seeded = await Promise.all(
    ids.devices.map((identity) => running.server.seedDevice(identity)),
  );

  if (detection) {
    const system = mintSystemDevice(seed, ids.tenantId);
    await running.server.seedSystemDevice({
      tenantId: system.tenantId,
      userId: system.userId,
      deviceId: system.deviceId,
      publicKeyBase64: system.publicKeyBase64,
    });
    systemSecrets.set(ids.tenantId, system.secret);
  }

  const handoffs = seeded.map((device) => describeDeviceHandoff(running, device));
  return {
    running,
    handshake: {
      // The bound port (for the driver's `adb reverse` + its teardown), the device-reachable base URL
      // (127.0.0.1 after `adb reverse`, identical across this scenario's devices — same server), and the
      // raw bearers in mint order.
      port: running.port,
      baseUrl: handoffs[0].reverseUrl,
      bearers: handoffs.map((handoff) => handoff.bearer),
    },
  };
}

async function main() {
  // Tear every server (socket + PGlite) down on the driver's SIGTERM or a Ctrl-C. Registered BEFORE the
  // first boot and closing whatever `servers` has recorded so far, so even a failure while booting the
  // second/third server still releases the first. Idempotent — once closing, ignore repeats — and it
  // exits 0 because a clean shutdown on request is success, not a fault.
  const servers = [];
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await Promise.all(servers.map((running) => running.close()));
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // CHAOS-03/06 plain (detection OFF); CHAOS-07 with detection ON. Each at its OWN default seed (see the
  // SEED PARITY note in the header) — the seed the matching on-device runner derives its identities from.
  const chaos03 = await bootScenario(
    servers,
    DEFAULT_CHAOS03_SEED,
    DEFAULT_CHAOS03_OPTIONS.deviceCount,
  );
  const chaos06 = await bootScenario(servers, DEFAULT_CHAOS06_SEED, CHAOS06_DEVICE_COUNT);
  const chaos07 = await bootScenario(servers, DEFAULT_CHAOS07_SEED, CHAOS07_DEVICE_COUNT, {
    detection: true,
  });

  // One handshake line the driver reads: per scenario, the bound port, the device-reachable base URL, and
  // the raw bearers in mint order.
  console.log(
    formatChaosNetHandshake({
      scenarios: {
        chaos03: chaos03.handshake,
        chaos06: chaos06.handshake,
        chaos07: chaos07.handshake,
      },
    }),
  );

  // Do NOT exit here: the open server sockets keep the event loop alive so the device can reach the host
  // during the driver's logcat poll. The process ends ONLY via `shutdown()` above.
}

main().catch((error) => {
  // A boot/seed failure must be LOUD and NON-ZERO: the driver then reads no handshake and reds the lane
  // (CHAOS-03/06/07 are REQUIRED gates — they cannot skip, §2.11). stderr so the driver's failure capture
  // shows it.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`harness-chaos-server: ${detail}`);
  process.exit(1);
});
