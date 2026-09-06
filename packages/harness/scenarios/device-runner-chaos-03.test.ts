// The HOST binding + WATCHED-RED control for the shared on-device CHAOS-03 runner (task 198 step 4).
//
// The device runner's body is `runChaos03`/`evaluateChaos03` in the platform-free rig
// (@bolusi/test-support/chaos) — the SAME functions the apps/mobile op-sqlite gate drives on the
// emulator. This file binds them the Node way and proves the verdict on a REAL loopback socket to the
// production `@bolusi/server`, so a green here means exactly what a green on device means (§2.8, T-7):
//   • DB engine  — `NODE_SEAMS` (better-sqlite3 + the real `@bolusi/modules` notes trio). On device the
//                  same seam is op-sqlite; the rig body never forks.
//   • SERVER     — an injected seam, exactly as the DB engine is: `socketBaseFetch(startHarnessServer().url)`
//                  turns the fixed `http://harness.test/...` transport origin into a genuine over-the-wire
//                  client of the production sync routes. On device it is the RN global `fetch` over
//                  `10.0.2.2` / `adb reverse` (§2.6). The push/pull phases are production, unchanged.
//   • IDENTITIES — `mintIdentities(seed, n)` is a pure function of the seed, so the host seeds those exact
//                  public keys server-side and hands the `bdt_harness_*` bearers back in MINT ORDER;
//                  `runChaos03` re-derives the same keypairs and pairs `net.auth[i]` with device `i`. No
//                  identity crosses the wire — only the seed agreement does.
//
// ── FALSIFICATION (§2.11 / task 198 Acceptance) ────────────────────────────────────────────────────
// The positive control is the normal run (a real 3-device offline merge that MUST land on the canonical
// fold, with a non-zero foreign-fold denominator so it cannot pass vacuously). The WATCHED-RED negative
// control drops ONE foreign `note_created` op from device 0's merge pull (`dropFromDevice0`): device 0
// MUST diverge from the fold while every untouched device converges, and `evaluateChaos03` must return a
// DIVERGENCE verdict (`ok:false`, `inconclusive:false`) — "converged" therefore means every op arrived,
// not that the oracle is blind. The control was watched red before shipping: neutering the drop
// (`dropFromDevice0:false`) makes the run converge normally, and the FIRST assertion to trip is the
// no-op-control guard — `expect(droppedOpId).not.toBeNull()` fails with "expected null not to be null"
// (nothing was dropped), with the `expect(verdict.ok).toBe(false)` assertion failing behind it since the
// run is now green. Restoring the drop returns both tests to green. So the control is doubly load-bearing:
// `droppedOpId` proves an op really WAS withheld (a control that silently dropped nothing — a false green
// — is caught here), and the normal-vs-drop pair proves the SAME run flips `ok` true→false on one lost op.
import { describe, expect, test } from 'vitest';

import { runChaos03, evaluateChaos03, type Chaos03Options } from '@bolusi/test-support/chaos';

import { driveDeviceRun } from './device-runner-harness.js';

/** A fixed run seed for this host binding (independent of the device runner's `DEFAULT_CHAOS03_SEED` —
 *  the verdict must hold for any fully-seeded run, so a distinct seed here is a second sample). */
const HOST_SEED = 3103;

/** A DELIBERATELY reduced host volume: this test proves the shared verdict + the socket seam, NOT a
 *  device's volume budget (that stays the Node days-offline scenario's job). 3 devices × 60 ops = 180
 *  notes, so every device has ≥ 120 foreign notes to fold — a real cross-device merge that crosses the
 *  §3.6 threshold, cheap over loopback. `sharedNotes` gives cross-device edits a target. */
const HOST_OPTIONS: Chaos03Options = { deviceCount: 3, opsPerDevice: 60, sharedNotes: 10 };

const RUN_TIMEOUT = 120_000;

/**
 * Drive one CHAOS-03 run over the shared {@link driveDeviceRun} host fixture (which owns the socket, the
 * identity seeding, the `net` seam, and teardown) and project the drop/replica figures this scenario asserts
 * on. The verdict is single-sourced (`evaluateChaos03`); its `metrics` already carries the foreign-fold and
 * converged-replica counts, so the projection reads those rather than re-deriving them from the raw result
 * (one source of truth for the numbers, §2.8).
 */
async function driveRun(options: Chaos03Options) {
  return driveDeviceRun({
    seed: HOST_SEED,
    deviceCount: options.deviceCount,
    run: (seed, seams, net) => runChaos03(seed, options, seams, net),
    project: (result) => {
      const verdict = evaluateChaos03(result, options);
      return {
        verdict,
        droppedOpId: result.droppedOpId,
        replicas: result.replicas.length,
        converged: verdict.metrics.converged,
        foreignApplied: verdict.metrics.foreignApplied,
      };
    },
  });
}

describe('CHAOS-03 device runner (host binding over a real socket)', () => {
  test(
    'a normal 3-device offline merge converges to the canonical fold over the wire',
    async () => {
      const { verdict, droppedOpId, replicas, converged, foreignApplied } =
        await driveRun(HOST_OPTIONS);

      // Positive control: a genuine merge, not a vacuous pass.
      expect(foreignApplied).toBeGreaterThan(0); // denominator: the merge really ran over the wire
      expect(droppedOpId).toBeNull(); // control off ⇒ nothing dropped
      expect(verdict.inconclusive).toBe(false); // crossed the merge threshold
      expect(converged).toBe(replicas); // every device landed on the fold
      expect(verdict.ok).toBe(true);
    },
    RUN_TIMEOUT,
  );

  test(
    'dropping one foreign op from device 0 DIVERGES it → the shared verdict FAILS (not inconclusive)',
    async () => {
      const { verdict, droppedOpId, replicas, converged } = await driveRun({
        ...HOST_OPTIONS,
        dropFromDevice0: true,
      });

      // The control actually withheld an op — a run that dropped NOTHING would be a false green, so
      // this non-null assertion is itself load-bearing (task 198 Acceptance: never pass on a no-op).
      expect(droppedOpId).not.toBeNull();
      // A real lost op, not an inconclusive run: the OTHER devices still converged, so the threshold
      // was crossed and the failure is DIVERGENCE, not "the merge never ran".
      expect(verdict.inconclusive).toBe(false);
      expect(converged).toBe(replicas - 1); // exactly device 0 diverged; the rest folded everything
      // This is the WATCHED-RED assertion: neutering the drop flips it to `true` and fails here.
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('device-0');
    },
    RUN_TIMEOUT,
  );
});
