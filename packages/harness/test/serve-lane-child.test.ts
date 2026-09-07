// TASK 201-B (subtask d) — the HOST §2.11 proof that the REAL lane serve entry runs, not just typechecks
// ("typed and compiling is not running on the target"). This SPAWNS `scripts/harness-serve-lane.mjs` as a
// separate Node process — the exact bare `node scripts/harness-serve-lane.mjs` invocation the (deferred)
// emulator-lane driver will run, NOT a helper — and drives its whole contract across the process boundary:
//   • it boots the production `@bolusi/server` on PGlite and binds a REAL loopback socket, printing ONE
//     ready-marker line the driver's own `parseLaneReady` accepts (format↔parse agreement, over a real pipe);
//   • the bind address in the marker is `127.0.0.1` — the §2.5 loopback-only guard in the entry, observed
//     over a real socket, not asserted in-process (this server mints REAL tokens; it MUST NOT reach the LAN);
//   • the credentials the marker carries actually authenticate against the bound socket over HTTP: the
//     provisioned one-time password logs in (200), a wrong password fails closed (401);
//   • SIGTERM tears the socket + PGlite down CLEANLY (exit 0) — the driver's teardown leaves no zombie
//     server or stray port on the CI host.
//
// The child loads the COMPILED barrel (`packages/harness/dist/index.js`), so this test needs `tsc -b` to have
// run — the same precondition `pnpm chaos` enforces before vitest. A stale dist would surface here as a
// missing export at child boot (a red marker-timeout), never a false green.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { awaitLaneReadyMarker, type LaneReady } from '../src/serve-lane.js';

// packages/harness/test/ → repo root is three levels up; the entry is a root-level script.
const ENTRY = fileURLToPath(new URL('../../../scripts/harness-serve-lane.mjs', import.meta.url));

// PGlite boot + migrations + argon2id provisioning is a few seconds; 120s is the same generous headroom the
// chaos net-child host test uses so a slow CI host never flakes this.
const BOOT_TIMEOUT = 120_000;

async function httpLogin(
  url: string,
  loginIdentifier: string,
  password: string,
): Promise<Response> {
  return fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier, password }),
  });
}

describe('task 201-B: the harness-serve-lane child entry (real host boot)', () => {
  // The one live child per test — killed hard in afterEach so a tripped assertion never leaks a server.
  let child: ReturnType<typeof spawn> | undefined;
  afterEach(() => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    child = undefined;
  });

  test(
    'boots on loopback, prints a parseable marker whose credentials authenticate, and exits 0 on SIGTERM',
    async () => {
      child = spawn(process.execPath, [ENTRY, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const spawned = child;

      // The SAME wait the lane driver uses (§2.8): poll stdout for the marker, settle early if the child
      // dies first. A child that exits before the marker resolves ready=undefined with its stderr captured.
      const outcome = await awaitLaneReadyMarker(spawned, { timeoutMs: BOOT_TIMEOUT });

      // No marker ⇒ the child never booted/bound/provisioned. Surface its stderr so a boot failure is legible.
      expect(outcome.ready, `no ready marker; child stderr:\n${outcome.stderr}`).toBeDefined();
      const marker = outcome.ready as LaneReady;

      // §2.5 over a real socket: the token-minting server bound loopback, never the LAN.
      expect(marker.address).toBe('127.0.0.1');
      expect(marker.url).toBe(`http://127.0.0.1:${marker.port}`);
      expect(marker.port).toBeGreaterThan(0);

      // The marker's credentials authenticate against the bound socket over HTTP: correct → 200, wrong → 401.
      const ok = await httpLogin(
        marker.url,
        marker.credentials.ownerLogin,
        marker.credentials.oneTimePassword,
      );
      expect(ok.status).toBe(200);
      const bad = await httpLogin(
        marker.url,
        marker.credentials.ownerLogin,
        'not-the-lane-password',
      );
      expect(bad.status).toBe(401);

      // Clean-teardown proof: the entry's SIGTERM handler closes the socket + PGlite and exits 0. A non-zero
      // code (or a signal death) would mean the driver's teardown leaks a server on CI.
      const exited = new Promise<number | null>((resolve) => {
        spawned.once('exit', (code) => resolve(code));
      });
      spawned.kill('SIGTERM');
      expect(await exited).toBe(0);
    },
    BOOT_TIMEOUT,
  );
});
