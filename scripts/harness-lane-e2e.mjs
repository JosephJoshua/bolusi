// The production-auth emulator-lane E2E driver (task 201-B, subtask e). This is the ONE process the
// emulator-gates step runs to exercise the promoted Maestro flows against a REAL enrolled+PIN owner:
//
//   1. spawn `scripts/harness-serve-lane.mjs` (forwarding this driver's own argv — the gates run passes
//      nothing, so it binds the fixed LANE_PORT; tests pass `--port 0` for an ephemeral port);
//   2. wait for its ONE ready-marker line via the SHARED `awaitLaneReadyMarker` (§2.8 — the same poll the
//      child-process test uses). NO marker ⇒ the server never booted/bound/provisioned ⇒ FAIL CLOSED:
//      print its stderr and exit non-zero, NEVER run `maestro` against a dead socket (§2.11 — a lane that
//      "passes" because the server was down is a green no-op, worse than no gate);
//   3. belt-check the marker's bound address is loopback (the entry already asserts this; the driver
//      re-asserts so a future change to the entry cannot quietly widen the token-minting surface);
//   4. run `maestro test` over the promoted flows. The guest app reaches the server via the emulator's
//      `10.0.2.2` NAT alias (the alias for the host's IPv4 `127.0.0.1`) — so there is NO `adb reverse`
//      here (that forwards the guest's OWN loopback, which the app, dialling `10.0.2.2`, never uses; the
//      CHAOS lane's `adb reverse` is for ITS chaos-net servers, a different mechanism);
//   5. propagate maestro's exit code — a red flow reds the lane — after tearing the server down cleanly so
//      the CI host is left with no zombie server or stray port.
//
// Imports the pure helpers from the COMPILED barrel (`packages/harness/dist/index.js`), so this needs
// `tsc -b` to have run first (ci.yml runs it before the gates). No tsx loader here: the driver never boots
// a server itself (that is the spawned entry's job, which registers its own loader), it only spawns + waits.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertLaneLoopbackBind, awaitLaneReadyMarker } from '../packages/harness/dist/index.js';

// scripts/harness-lane-e2e.mjs → repo root is one level up; the serve entry is its sibling. Maestro runs
// from the repo root so `.maestro/` and the `--test-output-dir` land where CI collects artifacts.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVE_ENTRY = fileURLToPath(new URL('./harness-serve-lane.mjs', import.meta.url));

// Same generous headroom the child-process host test uses — PGlite boot + migrations + argon2id provision
// is a few seconds; a slow CI host must never flake this before the marker.
const BOOT_TIMEOUT = 120_000;

// The maestro executable — overridable so the host test can point it at a stub that exits 0/1, proving the
// driver propagates the code + tears the server down without a real emulator. Defaults to `maestro`.
const MAESTRO_BIN = process.env.LANE_MAESTRO_BIN ?? 'maestro';

// Grace before a SIGTERM'd server is hard-killed, so a server that ignores SIGTERM cannot hang the driver.
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  // Forward our own args to the serve entry (the gates run passes none ⇒ fixed LANE_PORT; `--port 0` in
  // tests). The server outlives the blocking `maestro` call because it is a separate long-lived process.
  const serveArgs = process.argv.slice(2);
  const server = spawn(process.execPath, [SERVE_ENTRY, ...serveArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Teardown registered ONCE, fires on EVERY exit path: SIGTERM the server if it is still up. Idempotent.
  let tearingDown = false;
  const killServer = () => {
    if (tearingDown) return;
    tearingDown = true;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
    }
  };
  // Backstop for an unexpected driver exit (an uncaught throw slips past main().catch) — sync, as `exit`
  // handlers must be. The happy path below tears down explicitly and waits.
  process.once('exit', killServer);

  const outcome = await awaitLaneReadyMarker(server, { timeoutMs: BOOT_TIMEOUT });
  if (outcome.ready === undefined) {
    // FAIL CLOSED (§2.11): no marker ⇒ the lane server never came up. Surface its stderr and red the lane;
    // do NOT run maestro against a socket that isn't there (that would "pass" for the wrong reason).
    process.stderr.write(
      `harness-lane-e2e: lane server never signalled ready within ${BOOT_TIMEOUT}ms.\n${outcome.stderr}`,
    );
    killServer();
    process.exit(1);
  }

  // Belt to the serve entry's own §2.5 guard: the bound address the marker advertises must be loopback.
  assertLaneLoopbackBind(outcome.ready.address);

  // Surface the server's ongoing logs during the maestro run (the marker line was already consumed above).
  server.stdout?.pipe(process.stdout);
  server.stderr?.pipe(process.stderr);
  process.stdout.write(`harness-lane-e2e: lane ready at ${outcome.ready.url}; running maestro.\n`);

  const maestroCode = await new Promise((resolve) => {
    const maestro = spawn(
      MAESTRO_BIN,
      ['test', '--test-output-dir=maestro-artifacts', '.maestro/'],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      },
    );
    // A signal death (code === null) is a failure too — collapse it to a non-zero code.
    maestro.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    maestro.once('error', (error) => {
      process.stderr.write(
        `harness-lane-e2e: failed to spawn maestro (${MAESTRO_BIN}): ${error.message}\n`,
      );
      resolve(1);
    });
  });

  // Tear the server down and WAIT for its exit, so the driver leaves no zombie/stray port on the CI host.
  const serverExit = new Promise((resolve) => server.once('exit', () => resolve()));
  killServer();
  const grace = setTimeout(() => {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }, SHUTDOWN_GRACE_MS);
  await serverExit;
  clearTimeout(grace);

  process.exit(maestroCode);
}

main().catch((error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`harness-lane-e2e: ${detail}\n`);
  process.exit(1);
});
