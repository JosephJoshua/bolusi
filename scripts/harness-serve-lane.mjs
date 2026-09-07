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
// RESOLUTION (why imports are relative `dist/`, not `@bolusi/harness`): the repo-root `node_modules`
// carries NO `@bolusi/*` workspace link, so a bare specifier would not resolve for a root-level script.
// The built barrel resolves its OWN transitive `@bolusi/*` from the harness's `node_modules` (Node
// resolves a module's imports from the module's location, not the entry script's) — so this requires the
// harness + deps BUILT (`tsc -b`), which the emulator lane does before invoking this.
import { register } from 'tsx/esm/api';

import {
  assertLaneLoopbackBind,
  formatLaneReady,
  LANE_PORT,
  provisionLaneOwner,
  startHarnessServer,
} from '../packages/harness/dist/index.js';

// A TS-capable ESM loader, mandatory here: `startHarnessServer()` runs the DB migrator, which
// dynamically `import()`s the RAW `.ts` migration files (kysely's FileMigrationProvider). A bare `node`
// child cannot load `.ts`, so that import would die `ERR_MODULE_NOT_FOUND` and the server never boots.
// Use tsx's OWN `esm/api` register() (not `node:module`'s register('tsx/esm', …), which tsx rejects).
// The static imports above are compiled `dist/*.js` and need no loader; only the runtime migration
// `import()` inside `startHarnessServer` does, and it runs after this call.
register();

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

  // Tear the server (socket + PGlite) down on the driver's SIGTERM or a Ctrl-C. Registered BEFORE listen
  // so a signal arriving during boot still releases whatever came up. Idempotent, and exits 0 because a
  // clean shutdown on request is success, not a fault.
  let running;
  let closing = false;
  // Assigned once the server is up (the access-log drain below); a no-op until then, so a SIGTERM during
  // boot is safe. shutdown() flushes the tail first so the last request's record is never lost.
  let flushAccess = () => {};
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      flushAccess();
      await running?.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  running = await startHarnessServer({ productionAuth: true, port });

  // §2.5: fail closed if the bind is not loopback — a token-minting server must never reach the LAN. The
  // decision is the pure, unit-falsifiable `assertLaneLoopbackBind`; on reject we still close the socket
  // here so a refused bind never leaks a listening port.
  try {
    assertLaneLoopbackBind(running.address);
  } catch (error) {
    await running.close();
    throw error;
  }

  const credentials = await provisionLaneOwner(running.server);
  console.log(
    formatLaneReady({
      url: running.url,
      address: running.address,
      port: running.port,
      credentials,
    }),
  );

  // TASK 201 subtask (e) DIAGNOSTIC (systematic-debugging Phase 1.4 — instrument the boundary, do not
  // fix). The 01-launch-enrollment flow reds at `enroll-step-done` showing the `offline` banner, which
  // classifyFailure (apps/mobile screens/enrollment/model.ts) renders for ANY status-less throw inside
  // runEnrollment. The single discriminator between the two live hypotheses is whether `POST
  // /v1/devices/enroll` reached the server: login-logged-but-no-enroll ⇒ a PRE-POST throw (the on-device
  // UNSEEDED ed25519 keygen — the one enroll step no harness gate exercises); enroll-201-logged ⇒ a
  // POST-POST applyBundle/genesis divergence. Drain the PRODUCTION access-log records the server ALREADY
  // captures (apps/server middleware/access-log.ts: method/path/status/requestId/deviceId ONLY — never
  // the Authorization header, the OTP body, or a minted token; SEC-SECRET-01), which harness-lane-e2e.mjs
  // pipes into the CI job log. Diagnostic only — no production behavior changes; remove once the seam is
  // pinned.
  const accessLogs = running.server.accessLogs;
  let flushed = 0;
  flushAccess = () => {
    for (; flushed < accessLogs.length; flushed += 1) {
      console.log(`LANE_ACCESS ${accessLogs[flushed]}`);
    }
  };
  setInterval(flushAccess, 250).unref();

  // Do NOT exit here: the open socket keeps the event loop alive so the emulator can reach the host for
  // the whole Maestro run. The process ends ONLY via `shutdown()` above.
}

main().catch((error) => {
  // A boot/provision failure must be LOUD and NON-ZERO: the driver then reads no marker and reds the lane
  // (it cannot skip, §2.11). stderr so the driver's failure capture shows it.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`harness-serve-lane: ${detail}`);
  process.exit(1);
});
