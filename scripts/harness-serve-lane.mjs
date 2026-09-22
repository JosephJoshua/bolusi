// The production-auth emulator lane server entry (task 201-B, subtask d). Spawned as a SEPARATE Node
// process so the real `@bolusi/server` (Hono on PGlite) and its loopback socket OUTLIVE the lane
// driver's blocking `adb`/`maestro` calls — the server must stay up for the whole Maestro run, which a
// `spawnSync` in the driver could not hold (the exact shape `harness-chaos-server.mjs` uses for CHAOS).
//
// On boot it: (1) stands the production-auth server up on host loopback (`127.0.0.1`, fixed LANE_PORT by
// default, `--port 0` for an ephemeral port in tests), asserting the bind is loopback (§2.5: this server
// mints REAL control-session + device tokens, so it MUST NOT listen on the LAN — the guest reaches it via
// the `10.0.2.2` NAT alias, the emulator's alias for the host's IPv4 `127.0.0.1`, so loopback is both
// sufficient and safe; no `adb reverse`); (2) provisions the lane owner (deterministic LANE_OTP) and seeds
// the owner's LANE_PIN verifier (real argon2id) so the enroll bundle carries it; (3) prints ONE ready-marker
// line the driver waits on before it runs `maestro`. Then it stays alive on the open socket until
// SIGTERM/SIGINT, tearing the socket + PGlite down cleanly.
//
// Process scaffold (tsx loader, shutdown lifecycle, failure reporting) is shared with
// `harness-chaos-server.mjs` — see `harness-server-entry.mjs`, which also documents why these imports
// are relative `dist/` paths rather than `@bolusi/harness`.
import { installShutdownHandlers, registerTsLoader, runEntry } from './harness-server-entry.mjs';

import {
  formatLaneReady,
  LANE_PORT,
  provisionLaneOwner,
  startHarnessServer,
} from '../packages/harness/dist/index.js';

registerTsLoader();

/** Parse `--port <n>` (default LANE_PORT). `0` ⇒ ephemeral. Rejects anything outside a TCP port range. */
function parsePort(argv) {
  const flag = argv.indexOf('--port');
  if (flag === -1) return LANE_PORT;
  const raw = argv[flag + 1];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`harness-serve-lane: invalid --port ${String(raw)}`);
  }
  return port;
}

async function main() {
  const port = parsePort(process.argv.slice(2));

  // Tear the server (socket + PGlite) down on SIGTERM/Ctrl-C. The closure reads `running` at signal
  // time, not registration time, so a signal arriving mid-boot still releases whatever came up.
  let running;
  installShutdownHandlers(async () => running?.close());

  // §2.5 — the loopback bind is enforced at the BIND SITE, inside `listen()` (packages/harness/src/
  // server.ts): under `productionAuth` it runs `assertLaneLoopbackBind(hostname)` and throws BEFORE the
  // socket opens, so a token-minting server can never reach the LAN. There is deliberately no second
  // check on `running.address` here: `startHarnessServer` cannot return unless that guard already
  // passed, so a re-check would be unreachable code that reads like protection (task 209).
  //
  // That guard is load-bearing, watched go red: disabling it makes this server bind `0.0.0.0` and
  // `production-auth-boot.test.ts` fails with `promise resolved "{ url: 'http://0.0.0.0:…' }" instead
  // of rejecting`. Restore before trusting any of this.
  running = await startHarnessServer({ productionAuth: true, port });

  const credentials = await provisionLaneOwner(running.server);
  console.log(
    formatLaneReady({
      url: running.url,
      address: running.address,
      port: running.port,
      credentials,
    }),
  );

  // Do NOT exit here: the open socket keeps the event loop alive so the emulator can reach the host for
  // the whole Maestro run. The process ends ONLY via `shutdown()` above.
}

runEntry('harness-serve-lane', main);
