// The HOST binding + WATCHED-RED controls for the shared on-device CHAOS-07 runner (task 198 step 4).
//
// The device runner's body is `runChaos07`/`evaluateChaos07` in the platform-free rig
// (@bolusi/test-support/chaos) — the SAME functions the apps/mobile op-sqlite gate drives on the emulator.
// This file binds them the Node way and proves the verdict on a REAL loopback socket to the production
// `@bolusi/server` WITH conflict detection ON, so a green here means exactly what a green on device means
// (§2.8, T-7):
//   • DB engine  — `NODE_SEAMS` (better-sqlite3 + the real `@bolusi/modules` notes trio). On device the
//                  same seam is op-sqlite; the rig body never forks.
//   • SERVER     — `socketBaseFetch(startHarnessServer({systemKeyStore}).url)` turns the fixed
//                  `http://harness.test/...` transport origin into a genuine over-the-wire client of the
//                  production sync + conflict-detection routes. On device it is the RN global `fetch` over
//                  `10.0.2.2` / `adb reverse` (§2.6). The push/pull + detection pipeline is production.
//   • IDENTITIES — `mintIdentities(seed, 3)` is a pure function of the seed; the host seeds those exact
//                  member pubkeys AND the tenant's SYSTEM device (whose signer key matches the seeded
//                  `devices.signing_key_public`, 05 §2.2), then hands the `bdt_harness_*` bearers back in
//                  MINT ORDER. The rig re-derives the members and pairs `net.auth[i]` with device `i`; it
//                  never sees the system key (that is deployment-owned host setup, exactly as 03/06's).
//
// ── WHY THIS IS THE STRONGER CLAIM: leg 2 is verified over the WIRE ──────────────────────────────────
// The Node scenario chaos-07-conflicts.test.ts reads `server.db` and hand-feeds each server-minted op into
// a device with `applyForeign` (the engine fold, NO signature check). THIS test is the dual: device B does
// not read the server DB — it PULLS the system's `platform.conflict_detected` op over the real
// verify-and-quarantine pull path (sync/pull.ts) and folds it only if the signature verifies against the
// system pubkey the pull's devices sidecar carried. So `iiiDetectedApplied === true` (asserted below) is a
// discovered fact: B verified a system-signed op it received over the socket. A signer/seed pubkey
// mismatch would quarantine it (`bad_signature`, terminal) → it never lands in B's op log → the verdict is
// INCONCLUSIVE, not a pass. The positive test's `verdict.ok === true` therefore SUBSUMES the key-match
// proof — there is no separate "did the key match" assertion because a green cannot happen without it.
//
// ── FALSIFICATION (§2.11 / task 198 Acceptance) ─────────────────────────────────────────────────────
// Three controls, each watched red before shipping:
//   • POSITIVE — detection ON, oracle honest: 3/3 devices converge on the canonical LWW winner, and the
//     edit-after-archive conflict surfaces on device B (`surfacedOnDevice === 1`) from a system op B pulled
//     and verified. Every denominator is asserted so the green cannot be vacuous: `foreignApplied > 0` (the
//     pull path moved ops), `note1Edits > 0` (there was an LWW race to judge), and `iiiDetectedApplied`
//     (the system detection op actually reached B — the §2.11 non-vacuity witness for leg 2).
//   • WRONG-WINNER (WATCHED RED — task 198 Acceptance) — `reverseWinnerOracle:true` perturbs the
//     INDEPENDENT winner oracle to expect the FIRST edit, not the canonical `(timestamp,deviceId,seq)`
//     LAST. The devices still fold correctly, so the converged body no longer matches the (now-wrong)
//     oracle → `evaluateChaos07` MUST return a RED (`ok:false`, `inconclusive:false`) naming the wrong
//     winner. Watched red: turning the flag off makes the oracle expect C's canonical-last edit and the run
//     goes green, so `expect(verdict.ok).toBe(false)` trips ("expected true to be false"). The winner check
//     is load-bearing, not a tautology — the converged-but-wrong winner task 198 names is red.
//   • DETECTION-OFF INCONCLUSIVE (task 198) — boot WITHOUT `systemKeyStore` ⇒ `resolveDeps` leaves
//     `detectConflicts` undefined, so NO `platform.conflict_detected` op is ever minted. Leg 1 still LWW-
//     converges (the server just accepts the edits), so convergence + winner pass and the verdict falls
//     through to the `!iiiDetectedApplied` gate → INCONCLUSIVE (`inconclusive:true`), never a RED and never
//     green. "Never surfaced" is the inconclusive case task 198 forbids passing on; this proves the (iii)
//     guard is load-bearing — flip detection on (the positive test) and `iiiDetectedApplied` flips true and
//     the run goes green.
import { describe, expect, test } from 'vitest';

import {
  runChaos07,
  evaluateChaos07,
  CHAOS07_DEVICE_COUNT,
  type Chaos07Options,
} from '@bolusi/test-support/chaos';
import { noblePort } from '@bolusi/test-support';

import { mintIdentities } from '../src/identities.js';
import { socketBaseFetch } from '../src/net-server.js';
import { NODE_SEAMS } from '../src/seams-node.js';
import { startHarnessServer, type HarnessSystemKeyStore } from '../src/server.js';
import { mintSystemDevice } from '../src/system-identity.js';

/** A fixed run seed for this host binding (independent of the device runner's `DEFAULT_CHAOS07_SEED` — the
 *  verdict must hold for any fully-seeded run, so a distinct seed here is a second sample). */
const HOST_SEED = 7107;

/** A modest push batch — the CHAOS-07 workload is fixed-size (3 devices, 2 notes, a handful of edits), so
 *  this proves the verdict + the socket + the detection round trip, not a volume budget (D12/D20). */
const HOST_OPTIONS: Chaos07Options = { pushBatch: 20 };

const RUN_TIMEOUT = 120_000;

/**
 * Drive one CHAOS-07 run end to end over a real loopback socket, exactly as the device runner does except
 * the client DB is better-sqlite3 (NODE_SEAMS) instead of op-sqlite. When `detection` is on (the default),
 * boots the server with the tenant's `systemKeyStore` and seeds the matching system device, so the real
 * conflict-detection pipeline mints + signs the `platform.conflict_detected` op B pulls. Seeds the minted
 * member pubkeys, hands the bearers back in mint order, runs, evaluates, and tears BOTH the devices and the
 * socket/PGlite down in `finally`. Returns the verdict AND the raw observations, so the test can assert the
 * premise/non-vacuity denominators the verdict's `metrics` doesn't carry (`note1Edits`, `iiiDetectedApplied`).
 */
async function driveRun(options: Chaos07Options, config?: { detection?: boolean }) {
  const detection = config?.detection ?? true;
  const systemSecrets = new Map<string, Uint8Array>();
  const keyStore: HarnessSystemKeyStore = {
    getSystemSigner: (tenantId) => {
      const secret = systemSecrets.get(tenantId);
      return secret === undefined ? undefined : (hash) => noblePort.sign(hash, secret);
    },
  };
  const running = await startHarnessServer(detection ? { systemKeyStore: keyStore } : undefined);
  try {
    const ids = mintIdentities(HOST_SEED, CHAOS07_DEVICE_COUNT);
    const seeded = await Promise.all(ids.devices.map((id) => running.server.seedDevice(id)));

    // Detection ON: seed the tenant's system device + register its signing secret so the pipeline can
    // sign `platform.conflict_detected` with a key B will verify over the pull path. Detection OFF: no
    // system device / key — the detector never runs, so none is needed (the INCONCLUSIVE control).
    if (detection) {
      const system = mintSystemDevice(HOST_SEED, ids.tenantId);
      await running.server.seedSystemDevice({
        tenantId: system.tenantId,
        userId: system.userId,
        deviceId: system.deviceId,
        publicKeyBase64: system.publicKeyBase64,
      });
      systemSecrets.set(ids.tenantId, system.secret);
    }

    const net = { fetch: socketBaseFetch(running.url), auth: seeded.map((s) => s.auth) };
    const result = await runChaos07(HOST_SEED, options, NODE_SEAMS, net);
    try {
      // The verdict is single-sourced (`evaluateChaos07`); its `metrics` carries convergence/surfacing, so
      // the test asserts on those. The premise witness (`note1Edits`) and the leg-2 non-vacuity witness
      // (`iiiDetectedApplied` — the system op actually reached B) are NOT in `metrics`, so they come off
      // the raw `obs`.
      return { verdict: evaluateChaos07(result), obs: result.obs };
    } finally {
      await result.close();
    }
  } finally {
    await running.close();
  }
}

describe('CHAOS-07 device runner (host binding over a real socket)', () => {
  test(
    'concurrent edits converge on the canonical LWW winner and edit-after-archive surfaces on device B from a pulled system op',
    async () => {
      const { verdict, obs } = await driveRun(HOST_OPTIONS);

      // Denominators — the pass cannot be vacuous:
      expect(obs.foreignApplied).toBeGreaterThan(0); // the pull path moved ops
      expect(obs.note1Edits).toBeGreaterThan(0); // there was an LWW race to judge
      // The leg-2 non-vacuity witness AND the key-match proof (§2.11): B pulled the system-signed
      // conflict_detected op over the wire and VERIFIED it (else it would be quarantined, not applied).
      expect(obs.iiiDetectedApplied).toBe(true);
      // The properties themselves:
      expect(verdict.metrics.converged).toBe(verdict.metrics.deviceCount); // all 3 converged
      expect(verdict.metrics.surfacedOnDevice).toBe(1); // the significant conflict surfaced on B
      expect(verdict.inconclusive).toBe(false);
      expect(verdict.ok).toBe(true);
    },
    RUN_TIMEOUT,
  );

  test(
    'a converged-but-WRONG LWW winner → the shared verdict FAILS (not inconclusive)',
    async () => {
      const { verdict, obs } = await driveRun({ ...HOST_OPTIONS, reverseWinnerOracle: true });

      // The premise held (a real LWW race, and the devices DID converge) — so this is a genuine RED, not a
      // divergence or an inconclusive run: the failure is a wrong winner, judged after convergence passes.
      expect(obs.foreignApplied).toBeGreaterThan(0);
      expect(verdict.metrics.converged).toBe(verdict.metrics.deviceCount);
      expect(verdict.inconclusive).toBe(false);
      // WATCHED-RED: turning `reverseWinnerOracle` off makes the oracle expect C's canonical-last edit, the
      // converged body matches, and the run goes green — flipping this to `true` and failing here.
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('WRONG LWW winner');
    },
    RUN_TIMEOUT,
  );

  test(
    'detection OFF → no conflict_detected op reaches B → the verdict is INCONCLUSIVE, never RED',
    async () => {
      const { verdict, obs } = await driveRun(HOST_OPTIONS, { detection: false });

      // The pull path was live and leg 1 converged — so this is NOT the dead-pull INCONCLUSIVE. It is
      // inconclusive specifically because no `platform.conflict_detected` op was minted (detector off), so
      // there is nothing for (iii) to witness.
      expect(obs.foreignApplied).toBeGreaterThan(0);
      expect(obs.iiiDetectedApplied).toBe(false);
      expect(verdict.inconclusive).toBe(true);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('INCONCLUSIVE');
      expect(verdict.reason).toContain('conflict_detected');
    },
    RUN_TIMEOUT,
  );
});
