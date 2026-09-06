// The HOST binding + WATCHED-RED control for the shared on-device CHAOS-06 runner (task 198 step 4).
//
// The device runner's body is `runChaos06`/`evaluateChaos06` in the platform-free rig
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
//                  `runChaos06` re-derives the same keypairs and pairs `net.auth[i]` with device `i` (A
//                  replays, B authors the novel positive-control op). No identity crosses the wire — only
//                  the seed agreement does.
//
// ── FALSIFICATION (§2.11 / task 198 Acceptance) ────────────────────────────────────────────────────
// Three controls, each watched red before shipping:
//   • POSITIVE — the normal run: device A's first delivery is all-`accepted`, a verbatim replay comes back
//     all-`duplicate`, a held-op pull that RECEIVED A's own ops applies 0 with the fold unmoved, and a
//     NOVEL foreign op still applies and moves `edit_count`. Every denominator is asserted non-zero so the
//     green cannot be vacuous: `replayed > 0` (there was a replay to dedup), `heldPullReceived > 0` (the
//     held pull actually re-served ops — the §2.11 non-vacuity witness), `novelPullApplied > 0` (the pull
//     path is live). A pass with any denominator 0 is INCONCLUSIVE, never green.
//   • RE-INSERT (WATCHED RED) — `reinsertOnReplay:true` rewrites each replayed op's `duplicate` result to
//     `accepted`, simulating a server that re-inserts instead of deduping by id. `evaluateChaos06` MUST
//     return a RED (`ok:false`, `inconclusive:false`) naming the re-insert. Watched red: turning the flag
//     off makes the replay come back `duplicate` and the run goes green, so `expect(verdict.ok).toBe(false)`
//     trips ("expected true to be false"). So the SAME run flips ok true→false on a non-deduping server.
//   • INCONCLUSIVE — `skipFirstDelivery:true` skips the first delivery, so the replay pushes are first-seen
//     `accepted`, not `duplicate`. With no clean prior delivery a later `accepted` is NOT a re-insert, so
//     the verdict must be INCONCLUSIVE (`inconclusive:true`), never a RED and never green — the premise
//     guard is proven load-bearing, not assumed.
import { describe, expect, test } from 'vitest';

import {
  runChaos06,
  evaluateChaos06,
  CHAOS06_DEVICE_COUNT,
  type Chaos06Options,
} from '@bolusi/test-support/chaos';

import { driveDeviceRun } from './device-runner-harness.js';

/** A fixed run seed for this host binding (independent of the device runner's `DEFAULT_CHAOS06_SEED` —
 *  the verdict must hold for any fully-seeded run, so a distinct seed here is a second sample). */
const HOST_SEED = 6106;

/** A DELIBERATELY reduced host volume: this test proves the shared verdict + the socket seam, NOT a
 *  device's volume budget (that stays the on-device gate's job). Device A authors 1 genesis + 10 + 40 =
 *  51 wire ops, so at `pushBatch:20` the first delivery spans 3 batches ([20,20,11]) and the trailing 2
 *  replayed batches re-send 31 REAL ops — a batch replay, not a single op. Cheap over loopback. */
const HOST_OPTIONS: Chaos06Options = { creates: 10, edits: 40, pushBatch: 20, replayBatches: 2 };

const RUN_TIMEOUT = 120_000;

/**
 * Drive one CHAOS-06 run over the shared {@link driveDeviceRun} host fixture (which owns the socket, the
 * identity seeding, the `net` seam, and teardown) and return the verdict AND the raw observations, so the
 * test can assert the premise/non-vacuity denominators the verdict's `metrics` doesn't carry. The verdict is
 * single-sourced (`evaluateChaos06`); its `metrics` carries the replay/dedup/pull counts, so the test asserts
 * on those rather than re-deriving them (one source, §2.8), while the premise witness (firstDelivery*) and
 * the non-vacuity witness (heldPullReceived) come straight off the raw `obs`.
 */
async function driveRun(options: Chaos06Options) {
  return driveDeviceRun({
    seed: HOST_SEED,
    deviceCount: CHAOS06_DEVICE_COUNT,
    run: (seed, seams, net) => runChaos06(seed, options, seams, net),
    project: (result) => ({ verdict: evaluateChaos06(result), obs: result.obs }),
  });
}

describe('CHAOS-06 device runner (host binding over a real socket)', () => {
  test(
    'a verbatim replay is deduped on the wire and a held-op pull applies 0 — replay is idempotent',
    async () => {
      const { verdict, obs } = await driveRun(HOST_OPTIONS);

      // Premise: the first delivery was a clean, all-first-seen `accepted` chain — only then is a later
      // `accepted` a re-insert rather than a first delivery.
      expect(obs.firstDeliveryOps).toBeGreaterThan(0);
      expect(obs.firstDeliveryAccepted).toBe(obs.firstDeliveryOps);
      // Denominators — the pass cannot be vacuous:
      expect(verdict.metrics.replayed).toBeGreaterThan(0); // there was a replay to dedup
      expect(obs.heldPullReceived).toBeGreaterThan(0); // the held pull re-served A's own ops (§2.11)
      expect(verdict.metrics.novelPullApplied).toBeGreaterThan(0); // the pull path is live (positive ctrl)
      // The idempotency properties themselves:
      expect(verdict.metrics.duplicate).toBe(verdict.metrics.replayed); // every replayed op came back duplicate
      expect(verdict.metrics.heldPullApplied).toBe(0); // re-pulling held ops applied nothing
      expect(verdict.inconclusive).toBe(false);
      expect(verdict.ok).toBe(true);
    },
    RUN_TIMEOUT,
  );

  test(
    'a server that RE-INSERTS a replayed op (does not dedup by id) → the shared verdict FAILS (not inconclusive)',
    async () => {
      const { verdict, obs } = await driveRun({ ...HOST_OPTIONS, reinsertOnReplay: true });

      // The premise still held (a clean first delivery + a real replay) — so this is a genuine RED, not an
      // inconclusive run: the failure is a re-insert, judged AFTER the premise guards pass.
      expect(obs.firstDeliveryAccepted).toBe(obs.firstDeliveryOps);
      expect(verdict.metrics.replayed).toBeGreaterThan(0);
      expect(verdict.metrics.duplicate).toBe(0); // the control rewrote every duplicate → accepted
      expect(verdict.inconclusive).toBe(false);
      // This is the WATCHED-RED assertion: turning `reinsertOnReplay` off makes the replay come back
      // `duplicate` and the run goes green, flipping this to `true` and failing here.
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('re-inserted');
    },
    RUN_TIMEOUT,
  );

  test(
    'skipping the first delivery makes the replay first-seen → the verdict is INCONCLUSIVE, never RED',
    async () => {
      const { verdict, obs } = await driveRun({ ...HOST_OPTIONS, skipFirstDelivery: true });

      // No first delivery ran, so the premise never held: a later `accepted` cannot be read as a re-insert.
      expect(obs.firstDeliveryOps).toBe(0);
      expect(verdict.inconclusive).toBe(true);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('INCONCLUSIVE');
    },
    RUN_TIMEOUT,
  );
});
