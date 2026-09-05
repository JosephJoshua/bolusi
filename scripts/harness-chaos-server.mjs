// The CHAOS-03 HOST server child (task 198 step 4). Spawned by `pnpm harness:device`
// (scripts/harness-device.mjs `startChaosNetServer`) as a SEPARATE Node process, so the real
// `@bolusi/server` (Hono on PGlite) and the TCP socket it opens OUTLIVE the driver's blocking `adb`
// calls — a server must stay up for the whole logcat poll, which a `spawnSync` in the driver could not
// hold. On boot it:
//   1. starts the production server on host loopback (127.0.0.1, ephemeral port);
//   2. mints the CANONICAL CHAOS-03 identities from the shared seed — the SAME identities the on-device
//      `runChaos03` derives (mintIdentities is a pure fn of the seed; no identity crosses the wire, only
//      the seed agreement does — §2.8 / T-6);
//   3. seeds each device server-side and collects its `bdt_harness_*` bearer in MINT ORDER, so device i
//      pairs with `net.auth[i]` (chaos03 asserts `auth.length === deviceCount`);
//   4. prints ONE handshake line (`formatChaosNetHandshake`) the driver parses for the bound port +
//      the device-reachable base URL + the raw bearers.
// Then it stays alive on the open socket until SIGTERM/SIGINT (the driver's exit handler), tearing the
// server (socket + PGlite) down cleanly.
//
// RESOLUTION (why the imports are relative, not `@bolusi/harness`): the repo-root `node_modules` carries
// NO `@bolusi/*` workspace link, so a bare package specifier would not resolve for a script that lives
// at the repo root. The built barrel `packages/harness/dist/index.js`, however, resolves its OWN
// transitive `@bolusi/*` from the harness's own `node_modules` (Node resolves a module's imports from
// the module's location, not the entry script's). So this requires the harness + its deps to be BUILT
// (`tsc -b`), which the emulator lane does before `harness:device`. `formatChaosNetHandshake` comes from
// the sibling driver so the child and the driver agree on the wire BY CONSTRUCTION (round-trip pinned in
// packages/test-support/src/harness-device.test.ts).
import { register } from 'tsx/esm/api';

import {
  DEFAULT_CHAOS03_OPTIONS,
  DEFAULT_CHAOS03_SEED,
  describeDeviceHandoff,
  mintIdentities,
  startHarnessServer,
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
// `dist/*.js` and need no loader; only the runtime migration `import()` inside `main()` does, and it
// runs after this call — falsify by deleting this line: the child dies with the ERR_MODULE_NOT_FOUND
// above and the child-boot scenario reds.
register();

async function main() {
  const running = await startHarnessServer();

  // Tear the server (socket + PGlite) down on the driver's SIGTERM or a Ctrl-C. Registered BEFORE
  // seeding, so even a seed failure mid-boot still releases the socket. Idempotent — once closing,
  // ignore repeats — and it exits 0 because a clean shutdown on request is success, not a fault.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // Mint the canonical identities the device re-derives from the SAME seed, seed each server-side, and
  // collect the bearers in mint order. describeDeviceHandoff strips the `Bearer ` prefix (the device's
  // parseChaosNet re-adds it) and single-sources the 127.0.0.1 base-URL format (net-server.ts, §2.8).
  const ids = mintIdentities(DEFAULT_CHAOS03_SEED, DEFAULT_CHAOS03_OPTIONS.deviceCount);
  const seeded = await Promise.all(
    ids.devices.map((identity) => running.server.seedDevice(identity)),
  );
  const handoffs = seeded.map((device) => describeDeviceHandoff(running, device));

  // One handshake line the driver reads: the bound port (for `adb reverse` + its teardown), the
  // device-reachable base URL (127.0.0.1 after `adb reverse`, identical across devices — same server),
  // and the raw bearers in mint order.
  console.log(
    formatChaosNetHandshake({
      port: running.port,
      baseUrl: handoffs[0].reverseUrl,
      bearers: handoffs.map((handoff) => handoff.bearer),
    }),
  );

  // Do NOT exit here: the open server socket keeps the event loop alive so the device can reach the
  // host during the driver's logcat poll. The process ends ONLY via `shutdown()` above.
}

main().catch((error) => {
  // A boot/seed failure must be LOUD and NON-ZERO: the driver then reads no handshake and reds the lane
  // (CHAOS-03 is a REQUIRED gate — it cannot skip, §2.11). stderr so the driver's failure capture shows it.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`harness-chaos-server: ${detail}`);
  process.exit(1);
});
