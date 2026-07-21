// CHAOS-03 — days-offline bulk merge (testing-guide §3.6 / FR-1123).
//
// 4 devices author OFFLINE for 7 simulated days (~500 ops/day each ⇒ ≈ 3,500 ops/device, ≈ 14,000
// total) on a shared store, then reconnect ONE AT A TIME and full-sync. Each full sync is the REAL
// production push+pull phase pair (`runPushPhase`/`runPullPhase` via `pushDevice`/`pullDevice`,
// transport.ts — never re-implemented, T-7) against the REAL in-process `@bolusi/server` on PGlite.
//
// PASS (§3.6), asserted exhaustively:
//   1. CONVERGENCE — after the merge every device's notes digest == the canonical fold of the whole
//      ~14,000-op universe (the oracle, §3.4).
//   2. INCREMENTAL PULL — each device folds ONLY the ops it lacked, never the world. The direct
//      witness is `PullPhaseResult.applied` (pull.ts skips an op it already holds via `hasOp`): across
//      the reconnect passes every device applies EXACTLY the foreign ops it did not already hold and
//      re-folds none of its own; and a redundant final sync applies 0 AND the server serves an EMPTY
//      pull page (0 ops on the wire) — the cursor makes pull incremental, not a re-download of the
//      world every cycle.
//   3. ≤ 500 OPS/BATCH — a `CountingTransport` records every push request's `ops.length`; the max
//      across all pushes is ≤ 500 (api/01 §3). Not merely tidy: the server schema rejects a >500-op
//      push (`zSignedOperation[].max(500)`), so a batching bug would surface as a rejected push and a
//      convergence failure — the counter localizes it to the wire.
//
// SCALE (heavy scenario — testing-guide §3.7 D-CHAOS-SCALE, the worked example for the VOLUME lever):
// CHAOS-03's single-seed FULL volume is ~591 s (MEASURED, quiet box; 90 % inherent server round-trips
// + Ed25519 verify, folding < 1 s), so bounding the seed sweep alone still leaves a ~10-min gate file.
// Uniquely for CHAOS-03, the CI gate therefore ALSO reduces the VOLUME — to a DOCUMENTED, threshold-
// crossing level (`CI_OPS_PER_DAY`, ~5,040 ops, ≥ 3 push batches/device), NEVER a silent cut: the main
// test ASSERTS `pushBatches ≥ 2` so a future drop below the split threshold reds the gate (§3.6 / T-14).
// The NIGHTLY and any explicit `CHAOS_SEEDS=`/`CHAOS_SCALE=` run the FULL §3.6 14,000-op volume (and ×4
// under the nightly rule). Both volumes keep the 7-day days-offline STRUCTURE (only ops/day changes) —
// FR-1123 is a days-offline merge. `chaos03Seeds`/`chaos03OpsPerDay`/`isFullVolume` are the flags.
//
// FALSIFICATION (§2.11): the positive control is the main run itself (a real ~14,000-op merge that
// must land on the reference). The WATCHED-RED negative control drops one op AT THE MERGE BOUNDARY —
// one device never receives one foreign op — and asserts that device DIVERGES from the canonical fold
// while the reference and the untouched devices are unmoved: "converged" therefore means every op
// arrived, not that the oracle is blind. Both controls were watched red before this shipped.
import type { SyncTransportPort } from '@bolusi/core';
import { FakeClock, mulberry32, randomInt, type Prng } from '@bolusi/test-support';
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';
import { describe, expect, test } from 'vitest';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';
import { assertConvergence, canonicalFold, notesRows } from '../src/oracle.js';
import { HttpTransport, pullDevice, pushDevice } from '../src/transport.js';
import { activeVolumes, nightlyX4Seeds, resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;
const PUSH_BATCH = 500; // api/01 §3 cap.
const PULL_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Shared-note pool created by device 0 and delivered offline to the others so cross-device edits
 *  have a target (`editNote` throws ENTITY_NOT_FOUND for a note the device does not hold — the same
 *  reason convergence.ts pre-shares its pool). Large + spread edits keep each entity's history short,
 *  so the merge's re-fold cost (04 §4.2 re-folds an entity's WHOLE history) stays bounded. */
const SHARED_POOL = 300;
/** Fraction of a device's ops authored as edits on the shared pool (the rest own-note creates) —
 *  enough cross-device same-entity contention to make the merge real, low enough to bound re-fold. */
const EDIT_FRACTION = 0.15;

/**
 * A `SyncTransportPort` that WRAPS the production `HttpTransport` and records the wire-level counts
 * the two §3.6 wire properties assert: every push request's op count (≤ 500/batch) and every pull
 * response's op count (the incrementality witness). It adds NO protocol logic (T-7) — counts + delegates.
 */
class CountingTransport implements SyncTransportPort {
  readonly pushOpCounts: number[] = [];
  readonly pullOpCounts: number[] = [];
  constructor(private readonly inner: HttpTransport) {}

  push(request: PushRequest): Promise<PushResponse> {
    this.pushOpCounts.push(request.ops.length);
    return this.inner.push(request);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const response = await this.inner.pull(request);
    this.pullOpCounts.push(response.ops.length);
    return response;
  }

  /** Ops delivered over the wire in pull responses since the last reset — the re-download witness. */
  pulledSinceReset(): number {
    return this.pullOpCounts.reduce((a, b) => a + b, 0);
  }
  reset(): void {
    this.pushOpCounts.length = 0;
    this.pullOpCounts.length = 0;
  }
}

/** Only notes ops fold into the projection; the per-device genesis enroll op is not folded. */
function notesOnly(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.filter((op) => op.type.startsWith('notes.'));
}

/** A per-device authoring PRNG, distinct per (run seed, device index). */
function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e37_79b1) ^ Math.imul(index + 1, 0x85eb_ca77)) >>> 0;
}

/**
 * Author exactly `count` LOCAL ops on `device`, advancing the FakeClock by ~`stepMs` per op so a
 * device's whole run spans ≈ its intended day window. `EDIT_FRACTION` are spread edits on the shared
 * pool (cross-device contention); the rest are own-note creates.
 */
async function authorOffline(
  device: VirtualDevice,
  prng: Prng,
  count: number,
  stepMs: number,
  sharedIds: readonly string[],
): Promise<void> {
  const ownCreates: string[] = [];
  for (let k = 0; k < count; k += 1) {
    device.clock.advance(randomInt(prng, 1, Math.max(2, Math.floor(stepMs))));
    const canEdit = sharedIds.length > 0 || ownCreates.length > 0;
    if (canEdit && prng() < EDIT_FRACTION) {
      const pool = prng() < 0.85 || ownCreates.length === 0 ? sharedIds : ownCreates;
      const target = pool[randomInt(prng, 0, pool.length - 1)]!;
      await device.editNote(target, `edit-${device.identity.deviceId.slice(0, 6)}-${k}`);
    } else {
      ownCreates.push(
        await device.createNote({
          title: `own-${device.identity.deviceId.slice(0, 6)}-${k}`,
          body: `b-${k}`,
        }),
      );
    }
  }
}

interface BulkWorld {
  readonly server: HarnessServer;
  readonly devices: readonly VirtualDevice[];
  readonly transports: readonly CountingTransport[];
  /** Every NOTES op, deduped — the convergence fold input + authored-volume denominator (14,000). */
  readonly notesUniverse: readonly SignedOperation[];
  /** Count of ALL ops deduped, incl. each device's genesis `auth.device_enrolled` — the pull/applied
   *  accounting denominator (folded ops include foreign genesis, not just notes). = notes + DEVICES. */
  readonly universeAllCount: number;
  /** Notes ops each device AUTHORED — the "3,500/device" volume denominator. */
  readonly authoredNotes: readonly number[];
  /** ALL local ops each device pushes = genesis + authored notes (deviceId == self). = authored + 1. */
  readonly localCounts: readonly number[];
  /** Foreign ops each device already HOLDS before any sync (the pre-shared pool) — device 0: 0. */
  readonly preHeld: readonly number[];
  close(): Promise<void>;
}

/**
 * Build the CHAOS-03 world: `devices_` devices on one shared store; a `sharedPool` of notes created
 * by device 0 and delivered to the others OFFLINE (foreign/synced) so cross-device edits have a
 * target; then each device authors exactly `budget = days × opsPerDay` OWN local ops. For device 0
 * the pool creates are PART of its budget (it authors `budget − sharedPool` more), so every device
 * ends with the same authored count and the deduped universe is exactly `devices_ × budget`.
 */
async function buildWorld(
  seed: number,
  devices_: number,
  days: number,
  opsPerDay: number,
  sharedPool: number,
): Promise<BulkWorld> {
  const server = await HarnessServer.boot();
  const ids = mintIdentities(seed, devices_);
  const devices = await Promise.all(
    ids.devices.map((identity: DeviceIdentity, index: number) =>
      VirtualDevice.open({
        identity,
        clock: new FakeClock(CLOCK_BASE + index),
        prng: mulberry32(deviceSeed(seed, index)),
      }),
    ),
  );
  // Seed each device ONCE (idempotent row insert) and capture its real bearer.
  const seeded = await Promise.all(ids.devices.map((identity) => server.seedDevice(identity)));

  const budget = days * opsPerDay;
  const stepMs = DAY_MS / opsPerDay;

  // Device 0 creates the shared pool (part of its budget), delivered to every other device offline.
  const poolPrng = mulberry32(seed ^ 0x9001);
  const sharedIds: string[] = [];
  for (let n = 0; n < sharedPool; n += 1) {
    devices[0]!.clock.advance(randomInt(poolPrng, 1, 60_000));
    sharedIds.push(
      await devices[0]!.createNote({ title: `shared-${seed}-${n}`, body: `pool-${n}` }),
    );
  }
  const sharedCreates = notesOnly(await devices[0]!.wireOps());
  for (let d = 1; d < devices_; d += 1) {
    for (const op of sharedCreates) await devices[d]!.applyForeign(op);
  }

  // Offline authoring: device 0 authors the remainder of its budget; devices 1..n the full budget.
  await authorOffline(
    devices[0]!,
    mulberry32(deviceSeed(seed, 0) ^ 0x5bd1_e995),
    budget - sharedPool,
    stepMs,
    sharedIds,
  );
  for (let d = 1; d < devices_; d += 1) {
    await authorOffline(
      devices[d]!,
      mulberry32(deviceSeed(seed, d) ^ 0x5bd1_e995),
      budget,
      stepMs,
      sharedIds,
    );
  }

  const perDevice = await Promise.all(devices.map((dev) => dev.wireOps()));
  // Push/applied accounting is over ALL ops (each device's genesis `auth.device_enrolled` is a local
  // op it pushes, and a foreign genesis is folded on pull) — deviceId-based, not notes-only.
  const localCounts = devices.map(
    (dev, d) => perDevice[d]!.filter((op) => op.deviceId === dev.identity.deviceId).length,
  );
  const preHeld = devices.map(
    (dev, d) => perDevice[d]!.filter((op) => op.deviceId !== dev.identity.deviceId).length,
  );
  const authoredNotes = devices.map(
    (dev, d) =>
      notesOnly(perDevice[d]!).filter((op) => op.deviceId === dev.identity.deviceId).length,
  );
  const notesUniverse = dedupeById(perDevice.flatMap((ops) => notesOnly(ops)));
  const universeAllCount = dedupeById(perDevice.flat()).length; // notes + one genesis per device

  const transports = devices.map(
    (_, index) => new CountingTransport(new HttpTransport(server.fetch, seeded[index]!.auth)),
  );

  return {
    server,
    devices,
    transports,
    notesUniverse,
    universeAllCount,
    authoredNotes,
    localCounts,
    preHeld,
    close: async () => {
      for (const dev of devices) await dev.close();
      await server.close();
    },
  };
}

function dedupeById(ops: readonly SignedOperation[]): SignedOperation[] {
  const byId = new Map<string, SignedOperation>();
  for (const op of ops) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}

/** A full sync = the REAL push phase then the REAL pull-until-drained phase (transport.ts, T-7). */
async function fullSync(
  device: VirtualDevice,
  transport: SyncTransportPort,
): Promise<{ pushed: number; pushBatches: number; applied: number }> {
  const push = await pushDevice(device, transport, { batchSize: PUSH_BATCH });
  const pull = await pullDevice(device, transport, { limit: PULL_LIMIT });
  return { pushed: push.synced, pushBatches: push.batches, applied: pull.applied };
}

/**
 * The seeds this heavy scenario sweeps — DELIBERATELY bounded to the first CI seed (§3.7
 * D-CHAOS-SCALE), and flagged here rather than silently chosen. `CHAOS_SEEDS=…` (a reproduction) or
 * `CHAOS_NIGHTLY=1` runs every resolved seed.
 *
 * The ONE exception is the nightly ×4 LANE, where a single seed is ≈ 40 min (56,000 ops) and 100 of
 * them would never finish: there `nightlyX4Seeds` caps the SEED SAMPLE (never the volume) to the
 * documented `NIGHTLY_X4_SEED_CAPS['CHAOS-03']`. That cap is the nightly JOB's lever, owned by
 * `src/nightly-scale.ts` and asserted by `scenarios/nightly-seed-cap.test.ts` — it does not apply to
 * an explicit `CHAOS_SEEDS=` reproduction, which still runs verbatim at whatever scale it names.
 */
function chaos03Seeds(env: NodeJS.ProcessEnv = process.env): number[] {
  const seeds = nightlyX4Seeds('CHAOS-03', resolveSeeds(env), env);
  if (isFullVolume(env)) return seeds;
  return seeds.slice(0, 1);
}

/**
 * CHAOS-03 is the one scenario whose SINGLE-seed FULL volume is too expensive for the merge gate —
 * MEASURED at ~591 s/seed on a quiet box (§3.7 D-CHAOS-SCALE worked example), 90 % of it inherent
 * server round-trips + Ed25519 verification (14,000 push-verifies + ~42,000 pull re-verifies across
 * a 4-device merge; the fold itself is < 1 s). Bounding the SEED sweep alone still leaves a ~10-min
 * gate file — impractical. So, uniquely for CHAOS-03, the CI gate ALSO reduces the VOLUME to a
 * DOCUMENTED, threshold-crossing level (never a silent cut — §3.6 / T-14): `CI_OPS_PER_DAY` per
 * device-day, chosen so every device still splits its push into ≥ 3 batches (cursor pagination +
 * the ≤ 500 cap are genuinely exercised — the main test ASSERTS `pushBatches ≥ 2`, so a future drop
 * below the split threshold reds the gate). The NIGHTLY and any explicit `CHAOS_SEEDS=`/`CHAOS_SCALE=`
 * run the FULL §3.6 volume (`activeVolumes().bulkOpsPerDay`, ×scale). The days-offline STRUCTURE is
 * preserved at both volumes (7 FakeClock days; only ops/day is reduced) — FR-1123 is a days-offline
 * merge, so the days stay.
 */
const CI_OPS_PER_DAY = 180; // 4 devices × 7 days × 180 = 5,040 ops (~1,260/device ⇒ 3 push batches)

/** True when the full §3.6 volume must run: nightly, or any explicit seed/scale reproduction. */
function isFullVolume(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.CHAOS_SEEDS !== undefined && env.CHAOS_SEEDS !== '';
  const scaled = env.CHAOS_SCALE !== undefined && env.CHAOS_SCALE !== '' && env.CHAOS_SCALE !== '1';
  return explicit || scaled || env.CHAOS_NIGHTLY === '1';
}

/** Ops/day for this run: the FULL §3.6 volume under nightly/explicit, the reduced gate volume in CI. */
function chaos03OpsPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return isFullVolume(env) ? activeVolumes(env).bulkOpsPerDay : CI_OPS_PER_DAY;
}

describe('CHAOS-03 days-offline bulk merge', () => {
  const volumes = activeVolumes();
  const DEVICES = volumes.bulkDevices; // 4
  const DAYS = volumes.bulkDays; // 7 — the days-offline structure is preserved at BOTH volumes
  const OPS_PER_DAY = chaos03OpsPerDay(); // CI: reduced (documented); nightly/explicit: full §3.6
  const FULL = isFullVolume();
  const volumeTag = FULL
    ? `full ${DEVICES * DAYS * OPS_PER_DAY}`
    : `CI-reduced ${DEVICES * DAYS * OPS_PER_DAY}`;
  // The CI-reduced case is ~156 s on a quiet box; the shared CI box inflates 2–4× under load (the
  // §3.7 contention note), so it gets a 10-min ceiling — honest headroom for contention, not a masked
  // hang (a genuine hang still fails within 10 min). The full nightly/explicit case (~591 s quiet,
  // more under load) gets a 30-min ceiling — PER UNIT OF SCALE. The cost is volume-proportional, so
  // a flat 30 min would be BELOW the ×4 case's own quiet-box estimate (~40 min for 56,000 ops): the
  // nightly ×4 lane would time out every seed and report a red that is a budget artefact, not a bug.
  // Scaling the ceiling keeps the same ~3× headroom at every scale (×1 is unchanged — 30 min).
  const timeout = FULL ? 1_800_000 * volumes.scale : 600_000;

  for (const seed of chaos03Seeds()) {
    test(
      `CHAOS-03 4 devices offline 7 days, reconnect one at a time → converge (${volumeTag} ops); incremental pull; ≤500/batch [seed ${seed}]`,
      async () => {
        await withSeed(
          seed,
          async () => {
            const world = await buildWorld(seed, DEVICES, DAYS, OPS_PER_DAY, SHARED_POOL);
            try {
              const {
                devices,
                transports,
                notesUniverse,
                universeAllCount,
                authoredNotes,
                localCounts,
                preHeld,
              } = world;

              // Denominator (T-14): the world really is the resolved volume — not a silently shrunk run.
              const expectedNotes = DEVICES * DAYS * OPS_PER_DAY;
              expect(notesUniverse.length).toBe(expectedNotes); // 5,040 (CI) / 14,000 (full)
              for (const own of authoredNotes) expect(own).toBe(DAYS * OPS_PER_DAY); // 1,260 / 3,500 each
              // Every device pushes genesis + its authored notes; the whole-op universe adds one genesis
              // per device on top of the notes.
              for (let d = 0; d < DEVICES; d += 1)
                expect(localCounts[d]).toBe(authoredNotes[d]! + 1);
              expect(universeAllCount).toBe(expectedNotes + DEVICES);
              expect(preHeld[0]).toBe(0); // device 0 authored the pool — holds no foreign ops pre-sync
              for (let d = 1; d < DEVICES; d += 1) expect(preHeld[d]).toBe(SHARED_POOL);

              // Foreign ops each device must ultimately FOLD = the whole-op universe minus its own local
              // ops minus the pool it already holds (device 0 holds none).
              const foreignToFold = localCounts.map(
                (local, d) => universeAllCount - local - preHeld[d]!,
              );

              // ── PASS 1: reconnect one at a time ─────────────────────────────────────────────────
              // Device d pushes its own ops (≤500/batch), then pulls whatever is on the server ABOVE
              // its cursor — the ops of devices 0..d−1 that reconnected first, minus the pool it holds.
              const appliedTotal = new Array<number>(DEVICES).fill(0);
              for (let d = 0; d < DEVICES; d += 1) {
                const r = await fullSync(devices[d]!, transports[d]!);
                appliedTotal[d]! += r.applied;
                expect(r.pushed).toBe(localCounts[d]!); // pushed exactly its own local ops (genesis + notes)
                expect(r.pushBatches).toBe(Math.ceil(localCounts[d]! / PUSH_BATCH)); // batched
                // THRESHOLD GUARD (makes the reduced CI volume honest — main's crux, §2.11 / T-14):
                // every device's push MUST split into ≥ 2 batches, so the ≤500 cap and cursor
                // pagination are genuinely exercised, NOT vacuously satisfied by a single sub-500 batch.
                // A future volume drop below 500/device reds THIS line (falsified — see the task report).
                expect(r.pushBatches).toBeGreaterThanOrEqual(2);
                // Pass-1 incrementality: folds exactly devices 0..d−1's ops, minus the pool already
                // held (only when device 0 is among them, i.e. d ≥ 1) — never its own, never the world.
                const foreignBelow = localCounts.slice(0, d).reduce((a, b) => a + b, 0);
                const poolAlreadyHeld = d >= 1 ? SHARED_POOL : 0;
                expect(r.applied).toBe(foreignBelow - poolAlreadyHeld);
              }

              // ── PASS 2: sync all again ─────────────────────────────────────────────────────────
              // Device d now pulls the ops of devices d+1..n−1 (pushed after its pass-1 sync). Nothing
              // to push (its own ops are already synced).
              for (let d = 0; d < DEVICES; d += 1) {
                const r = await fullSync(devices[d]!, transports[d]!);
                appliedTotal[d]! += r.applied;
                expect(r.pushed).toBe(0);
                expect(r.pushBatches).toBe(0);
              }

              // Across both passes every device folded EXACTLY its foreign universe — never the world,
              // never its own ops, never the pool twice — AND every device pulled a NON-ZERO count of
              // foreign ops (the incremental-pull property is exercised, not vacuously 0).
              for (let d = 0; d < DEVICES; d += 1) {
                expect(foreignToFold[d]!).toBeGreaterThan(0); // denominator: there WAS foreign to fold
                expect(appliedTotal[d]!).toBe(foreignToFold[d]!);
              }

              // ── ≤ 500 OPS/BATCH (wire witness, over the pushes that ACTUALLY happened) ──────────
              // Snapshot BEFORE the pass-3 reset — all real pushes were in pass 1 (pass 2/3 push
              // nothing). Denominator (T-14): each device made ≥ 1 push request; the largest device
              // (localCounts > cap) split into ⌈local/500⌉ requests; and NO request ever exceeded 500.
              const pushWire = transports.map((t) => [...t.pushOpCounts]);
              for (let d = 0; d < DEVICES; d += 1) {
                expect(pushWire[d]!.length).toBeGreaterThanOrEqual(1); // not a vacuous empty loop
                expect(pushWire[d]!.length).toBe(Math.ceil(localCounts[d]! / PUSH_BATCH));
                expect(pushWire[d]!.reduce((a, b) => a + b, 0)).toBe(localCounts[d]!); // no op lost
                for (const c of pushWire[d]!) expect(c).toBeLessThanOrEqual(PUSH_BATCH);
              }

              // ── PASS 3: no re-download of the world ────────────────────────────────────────────
              // A redundant sync moves nothing: 0 applied AND an EMPTY pull page over the wire (the
              // cursor is at head). Asserted at BOTH the fold level (applied) and the wire (pull count).
              for (let d = 0; d < DEVICES; d += 1) {
                transports[d]!.reset();
                const r = await fullSync(devices[d]!, transports[d]!);
                expect(r.applied).toBe(0);
                expect(r.pushed).toBe(0);
                expect(transports[d]!.pulledSinceReset()).toBe(0); // empty page — nothing re-served
              }

              // ── CONVERGENCE ────────────────────────────────────────────────────────────────────
              const reference = await canonicalFold(notesUniverse);
              const replicas = await Promise.all(
                devices.map(async (device, index) => ({
                  name: `device-${index}`,
                  digest: await device.digest(),
                  rows: await notesRows(device.db),
                })),
              );
              assertConvergence(reference, replicas);
            } finally {
              await world.close();
            }
          },
          'CHAOS-03',
        );
      },
      timeout,
    );
  }

  // WATCHED-RED positive control at a small, explicitly-reduced CONTROL volume (this proves the MERGE
  // surfaces a lost op — it is NOT a volume claim, so it need not run at spec scale). One device never
  // receives one foreign op AT THE MERGE BOUNDARY: it must DIVERGE from the canonical fold while the
  // reference and the untouched device stand. Watched red before shipping (see the task report).
  test('CHAOS-03 positive control: dropping one op at the merge boundary DIVERGES that device from the fold', async () => {
    const seed = 1;
    const CONTROL_OPS = 60; // per device; 4 × 60 = 240 ops — a real merge, cheap to run
    const world = await buildWorld(seed, activeVolumes().bulkDevices, 1, CONTROL_OPS, 20);
    try {
      const { devices, transports, notesUniverse } = world;
      const device1Notes = notesOnly(await devices[1]!.wireOps()).filter(
        (op) => op.deviceId === devices[1]!.identity.deviceId,
      );
      const dropId = device1Notes[1]!.id; // a device-1 authored op to withhold from device 0

      // Pass 1: reconnect all devices normally so every op reaches the server.
      for (let d = 0; d < devices.length; d += 1) await fullSync(devices[d]!, transports[d]!);

      // Device 0's pass-2 pull is served through a transport that DROPS `dropId` from every pull
      // response — the op is lost at device 0's merge boundary ONLY. Every other device syncs normally.
      const dropping = new DroppingPullTransport(transports[0]!, dropId);
      await pushDevice(devices[0]!, dropping, { batchSize: PUSH_BATCH });
      await pullDevice(devices[0]!, dropping, { limit: PULL_LIMIT });
      for (let d = 1; d < devices.length; d += 1) await fullSync(devices[d]!, transports[d]!);

      const reference = await canonicalFold(notesUniverse);
      // A device that saw all ops converges; device 0 (missing one) DIVERGES — the oracle is not blind.
      expect(await devices[1]!.digest()).toBe(reference.digest);
      expect(await devices[0]!.digest()).not.toBe(reference.digest);
    } finally {
      await world.close();
    }
  });
});

/**
 * A pull transport wrapper that DROPS one op (by id) from every pull response — the merge-boundary
 * loss the positive control needs. Push is delegated verbatim; only pull is filtered. Test-only, owns
 * no protocol logic beyond the deletion under test (T-7).
 */
class DroppingPullTransport implements SyncTransportPort {
  constructor(
    private readonly inner: SyncTransportPort,
    private readonly dropId: string,
  ) {}
  push(request: PushRequest): Promise<PushResponse> {
    return this.inner.push(request);
  }
  async pull(request: PullRequest): Promise<PullResponse> {
    const response = await this.inner.pull(request);
    return { ...response, ops: response.ops.filter((op) => op.id !== this.dropId) };
  }
}
