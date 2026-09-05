// The HOST-side §2.11 proof for the CHAOS-03 net child server (task 198 step 4). "A mention is not a
// producer — trace to one", and "typed and compiling is not running on the target": the child server
// (scripts/harness-chaos-server.mjs) is a real Node process that boots the production `@bolusi/server` on
// PGlite, mints the canonical identities, seeds them, and prints ONE handshake line. This test SPAWNS
// that real child through the driver's OWN `startChaosNetServer` (the exact spawn→poll→handshake path the
// emulator lane runs) and proves:
//   • the child produces a handshake the driver's `parseChaosNetHandshake` actually accepts (not just a
//     line that looks right by eye) — the format↔parse agreement, exercised across a real process boundary;
//   • the base URL is the loopback `adb reverse` form (127.0.0.1:<bound port>), reachable identically by
//     the emulator and a future physical device (27b), never the emulator-only 10.0.2.2;
//   • one raw `bdt_harness_*` bearer per CHAOS-03 device, prefix-less on the wire and all distinct;
//   • SIGTERM tears the server down CLEANLY (exit 0) — the driver's teardown leaves no zombie server or
//     stray socket on the CI host.
//
// This is the child's HOST half only. The device half — op-sqlite driving these bearers over the reversed
// socket — is the emulator lane's job (there is no AVD on this dev host, D12); the shared verdict body it
// runs is already bound and watched-red in device-runner-chaos-03.test.ts.
import { describe, expect, test } from 'vitest';

import { DEFAULT_CHAOS03_OPTIONS } from '@bolusi/test-support/chaos';

// @ts-expect-error — plain .mjs driver without type declarations (mirrors harness-device.test.ts).
import * as driver from '../../../scripts/harness-device.mjs';

// PGlite boot + seeding a handful of devices is a few seconds; 120s is generous headroom, matching the
// host-binding runner's budget so a slow CI host never flakes this.
const BOOT_TIMEOUT = 120_000;

describe('CHAOS-03 net child server (real host boot)', () => {
  test(
    'boots the real server, prints a driver-parseable handshake, and tears down clean on SIGTERM',
    async () => {
      const { child, handshake } = driver.startChaosNetServer(BOOT_TIMEOUT);
      try {
        const hs = await handshake;

        // A null here would mean the child never booted/seeded/printed — the failure the driver turns
        // into a non-zero lane exit. A green means the whole child→driver handshake really happened.
        expect(hs).not.toBeNull();
        expect(Number.isInteger(hs.port) && hs.port > 0).toBe(true);
        // The loopback `adb reverse` base URL — same for emulator and physical device, not 10.0.2.2.
        expect(hs.baseUrl).toBe(`http://127.0.0.1:${hs.port}`);

        // One bearer per CHAOS-03 device, in mint order — the count the device re-derives from the seed.
        expect(hs.bearers).toHaveLength(DEFAULT_CHAOS03_OPTIONS.deviceCount);
        for (const bearer of hs.bearers as string[]) {
          // Real minted device tokens, handed off prefix-less (the device re-adds `Bearer `).
          expect(bearer).toMatch(/^bdt_harness_/);
          expect(bearer).not.toMatch(/^Bearer /i);
        }
        // Distinct devices ⇒ distinct bearers; a duplicated token would mean two devices shared identity.
        expect(new Set(hs.bearers as string[]).size).toBe((hs.bearers as string[]).length);

        // Clean-teardown proof: the child's SIGTERM handler closes the socket + PGlite and exits 0. A
        // non-zero code (or a signal death) would mean the driver's teardown leaks a server on CI.
        const exited = new Promise<number | null>((resolve) => {
          child.once('exit', (code: number | null) => resolve(code));
        });
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
      } finally {
        // Belt to the SIGTERM braces: if any assertion tripped while the child was still alive, make sure
        // this test never leaves a server behind for the next scenario.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    BOOT_TIMEOUT,
  );
});
