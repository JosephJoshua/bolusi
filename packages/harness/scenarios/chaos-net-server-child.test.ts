// The HOST-side §2.11 proof for the CHAOS-03/06/07 net child server (task 198 step 4). "A mention is not a
// producer — trace to one", and "typed and compiling is not running on the target": the child server
// (scripts/harness-chaos-server.mjs) is a real Node process that boots the production `@bolusi/server` on
// PGlite ONCE PER SCENARIO (03/06 plain, 07 with conflict detection), mints each scenario's canonical
// identities, seeds them, and prints ONE handshake line covering all three. This test SPAWNS that real
// child through the driver's OWN `startChaosNetServer` (the exact spawn→poll→handshake path the emulator
// lane runs) and proves:
//   • the child produces a handshake the driver's `parseChaosNetHandshake` actually accepts (not just a
//     line that looks right by eye) — the format↔parse agreement, exercised across a real process boundary;
//   • EACH scenario's base URL is the loopback `adb reverse` form (127.0.0.1:<bound port>), reachable
//     identically by the emulator and a future physical device (27b), never the emulator-only 10.0.2.2;
//   • one raw `bdt_harness_*` bearer per scenario device (03/06/07 counts), prefix-less on the wire and all
//     distinct within the scenario;
//   • SIGTERM tears EVERY server down CLEANLY (exit 0) — the driver's teardown leaves no zombie server or
//     stray socket on the CI host.
//
// This is the child's HOST half only. The device half — op-sqlite driving these bearers over the reversed
// sockets — is the emulator lane's job (there is no AVD on this dev host, D12); the shared verdict bodies it
// runs are already bound and watched-red in device-runner-chaos-0{3,6,7}.test.ts.
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CHAOS03_OPTIONS,
  CHAOS06_DEVICE_COUNT,
  CHAOS07_DEVICE_COUNT,
} from '@bolusi/test-support/chaos';

// @ts-expect-error — plain .mjs driver without type declarations (mirrors harness-device.test.ts).
import * as driver from '../../../scripts/harness-device.mjs';

// PGlite boot + seeding is a few seconds PER scenario, and the child now boots three; 120s is generous
// headroom, matching the host-binding runner's budget so a slow CI host never flakes this.
const BOOT_TIMEOUT = 120_000;

/** The expected device (bearer) count for each scenario, in the handshake's fixed order. CHAOS-03 carries
 * its count on the options object; 06/07 carry theirs as standalone constants (they have no options-level
 * deviceCount). */
const EXPECTED_BEARER_COUNTS: ReadonlyArray<[string, number]> = [
  ['chaos03', DEFAULT_CHAOS03_OPTIONS.deviceCount],
  ['chaos06', CHAOS06_DEVICE_COUNT],
  ['chaos07', CHAOS07_DEVICE_COUNT],
];

describe('CHAOS-03/06/07 net child server (real host boot)', () => {
  test(
    'boots the real servers, prints a driver-parseable handshake, and tears down clean on SIGTERM',
    async () => {
      const { child, handshake } = driver.startChaosNetServer(BOOT_TIMEOUT);
      try {
        const hs = await handshake;

        // A null here would mean the child never booted/seeded/printed all three — the failure the driver
        // turns into a non-zero lane exit. A green means the whole child→driver handshake really happened.
        expect(hs).not.toBeNull();

        for (const [id, expectedCount] of EXPECTED_BEARER_COUNTS) {
          const scenario = hs.scenarios[id];
          expect(scenario, `handshake missing scenario ${id}`).toBeDefined();
          expect(Number.isInteger(scenario.port) && scenario.port > 0).toBe(true);
          // The loopback `adb reverse` base URL — same for emulator and physical device, not 10.0.2.2.
          expect(scenario.baseUrl).toBe(`http://127.0.0.1:${scenario.port}`);

          // One bearer per scenario device, in mint order — the count the device re-derives from the seed.
          const bearers = scenario.bearers as string[];
          expect(bearers).toHaveLength(expectedCount);
          for (const bearer of bearers) {
            // Real minted device tokens, handed off prefix-less (the device re-adds `Bearer `).
            expect(bearer).toMatch(/^bdt_harness_/);
            expect(bearer).not.toMatch(/^Bearer /i);
          }
          // Distinct devices ⇒ distinct bearers; a duplicated token would mean two devices shared identity.
          expect(new Set(bearers).size).toBe(bearers.length);
        }

        // Each scenario is a SEPARATE server, so their bound ports must differ — a shared port would mean
        // detection-on and detection-off traffic hit the same server (03/06/07 cannot share one, since
        // detection is a server-wide boot gate).
        const ports = EXPECTED_BEARER_COUNTS.map(([id]) => hs.scenarios[id].port as number);
        expect(new Set(ports).size).toBe(ports.length);

        // Clean-teardown proof: the child's SIGTERM handler closes every socket + PGlite and exits 0. A
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
