// TASK 201-B (subtask e) — the HOST §2.11 proof that the REAL lane E2E driver runs end-to-end, short of
// the emulator itself. It SPAWNS `scripts/harness-lane-e2e.mjs` — the exact process the emulator-gates step
// runs — with `LANE_MAESTRO_BIN` pointed at a stub that exits on demand, so the ONLY thing not exercised is
// the on-device maestro run (that is the emulator lane's job). Everything else is real: the driver boots the
// production `@bolusi/server` on PGlite over a loopback socket, waits on the shared marker, belt-checks the
// bound address, runs the (stubbed) maestro, and propagates its code after tearing the server down.
//
// The two load-bearing behaviours (§2.11 falsification targets):
//   • a GREEN maestro run ⇒ the driver exits 0 (the lane passes) — and the ready line proves the seam ran;
//   • a RED maestro run ⇒ the driver exits NON-ZERO. This is the whole point of the gate: a failing flow
//     must red the lane, never be swallowed. The stub's exit code is the flows' verdict in miniature.
//
// The child loads the COMPILED barrel via the driver's imports, so this needs `tsc -b` to have run — a stale
// dist surfaces as a driver-boot failure (a red marker-timeout), never a false green.
import { chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, test } from 'vitest';

// packages/harness/test/ → repo root is three levels up; the driver + the maestro stub.
const DRIVER = fileURLToPath(new URL('../../../scripts/harness-lane-e2e.mjs', import.meta.url));
const STUB_MAESTRO = fileURLToPath(new URL('./fixtures/stub-maestro.mjs', import.meta.url));

// Same headroom the other lane host tests use — a real PGlite boot is a few seconds.
const BOOT_TIMEOUT = 120_000;

interface DriverRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the driver with the stub maestro forced to `stubExit`, capturing its exit code + output. */
function runDriver(stubExit: number): {
  child: ReturnType<typeof spawn>;
  done: Promise<DriverRun>;
} {
  const child = spawn(process.execPath, [DRIVER, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANE_MAESTRO_BIN: STUB_MAESTRO, STUB_MAESTRO_EXIT: String(stubExit) },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<DriverRun>((resolve) => {
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

describe('task 201-B: the harness-lane-e2e driver propagates the maestro verdict (real host boot)', () => {
  beforeAll(() => {
    // Git may not preserve the exec bit on checkout; the driver spawns the stub directly, so ensure it.
    chmodSync(STUB_MAESTRO, 0o755);
  });

  let child: ReturnType<typeof spawn> | undefined;
  afterEach(() => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    child = undefined;
  });

  test(
    'a passing maestro run ⇒ the driver boots the lane, runs maestro, and exits 0',
    async () => {
      const run = runDriver(0);
      child = run.child;
      const result = await run.done;
      // The seam actually ran: the driver logged the loopback lane URL before invoking maestro.
      expect(result.stdout, `driver stderr:\n${result.stderr}`).toMatch(
        /lane ready at http:\/\/127\.0\.0\.1:\d+/,
      );
      // Green flows ⇒ green lane.
      expect(result.code, `driver stderr:\n${result.stderr}`).toBe(0);
    },
    BOOT_TIMEOUT,
  );

  test(
    'a failing maestro run ⇒ the driver exits non-zero (the red flow reds the lane, §2.11)',
    async () => {
      const run = runDriver(1);
      child = run.child;
      const result = await run.done;
      // The lane still came up (so this is the maestro verdict, not a boot failure)...
      expect(result.stdout, `driver stderr:\n${result.stderr}`).toMatch(
        /lane ready at http:\/\/127\.0\.0\.1:/,
      );
      // ...and the failing flow propagated to a non-zero driver exit — the gate cannot swallow it.
      expect(result.code).not.toBe(0);
    },
    BOOT_TIMEOUT,
  );
});
