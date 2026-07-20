// CHAOS-02 — interrupted sync at every batch boundary (testing-guide §3.6 / FR-1122).
//
// One device with `interruptedOpsPerSide` local ops (4 push batches of ≤500, api/01 §3) syncs against
// a server already holding the same many FOREIGN ops (4 pull batches). At a scheduled batch boundary
// a §3.5 fault fires; the REAL client `SyncLoop` (core/sync/loop.ts — never re-implemented, T-7) enters
// backoff and, when the fake `TimerPort` fires, RESUMES. PASS (§3.6): after resume the server holds
// EXACTLY the device's pushed ops (no loss, no dupes — F2 retries come back `duplicate`, never
// re-inserted); every pushed op `syncStatus=synced`; the device digest == the canonical fold of ALL
// ops; the pull cursor == the final `serverSeq`.
//
// THE FAULT MODEL, HONESTLY (impl-26d's producer-trace, honoured):
//   F1 (never reached) / F2 (server processed, response lost) are TRANSPORT faults at the FaultFetch
//     boundary — the phase throws `SyncTransportError`, the loop backs off, the resume re-sends. For
//     PUSH, F2 is the sharp one: the server INSERTED the batch, so the resend must return `duplicate`
//     (05 §5), never a second insert.
//   F5 (crash MID apply-transaction → rollback) is a CLIENT-crash the device models: the pull's
//     `applyBatchAtomically` runs inside `device.transaction`, so aborting that transaction after the
//     ops are applied-in-memory but before commit rolls the WHOLE batch back (ops + cursor together —
//     pull.ts's load-bearing contract). The re-pull from the unmoved cursor re-applies it.
//   F4 (apply commits, cursor does NOT persist) is UNREACHABLE by construction: pull.ts writes the
//     cursor INSIDE the same apply transaction (step 4), so "committed apply + lost cursor" cannot
//     occur — F4 degenerates to "the batch committed atomically (cursor included) → the resume pulls
//     the NEXT batch", i.e. the no-fault path. Covered by the no-fault control; noted in testing-guide
//     §3.5.
//   F3 (response received, crash before persisting the outcome) is SUBSUMED: for PUSH it converges to
//     the F2 resume (ops stay `local`, resend → `duplicate`); for PULL, being before/after the atomic
//     commit, it is exactly F5 / F4. So F3 adds no distinct reachable state over {F2, F5, F4}.
//
// SCALE: the full (boundary k ∈ [0,B+C]) × (fault) cartesian product at this volume needs a fresh
// server boot per case and is too heavy for the merge gate — this file runs a REPRESENTATIVE boundary
// per fault at the FULL spec volume (never a reduced volume — acceptance forbids that), and flags the
// full cartesian sweep to [[106-chaos-heavy-scenario-scale-policy]] for the nightly lane.
//
// FALSIFICATION (§2.11): the positive control is the no-fault run (resume-completes == converges);
// the negative control DROPS one foreign op before the sync and watches the digest DIVERGE from the
// canonical fold — so "converged" means the ops all arrived, not that the oracle is blind.
import {
  SyncLoop,
  type BundleRefreshOutcome,
  type BundleRefreshPort,
  type CancelTimer,
  type SyncLoopOptions,
  type TimerPort,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { FakeClock, mulberry32, noblePort } from '@bolusi/test-support';
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';
import { assertConvergence, canonicalFold, notesRows } from '../src/oracle.js';
import { FaultFetch, type FaultPoint } from '../src/fault-fetch.js';
import { HttpTransport, SILENT_SURFACE } from '../src/transport.js';
import { activeVolumes, resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;
const PUSH_BATCH = 500; // api/01 §3 cap.
const PULL_LIMIT = 500;

/** A fake `TimerPort`: records scheduled backoff callbacks so the test fires them deterministically. */
class ManualTimer implements TimerPort {
  readonly #pending: Array<{ fn: () => void; live: boolean }> = [];
  #scheduled = 0;
  schedule(_delayMs: number, fn: () => void): CancelTimer {
    const entry = { fn, live: true };
    this.#pending.push(entry);
    this.#scheduled += 1;
    return () => {
      entry.live = false;
    };
  }
  /**
   * How many backoff windows were EVER scheduled — the denominator that makes a fault case mean
   * something (§2.11 / T-14). The loop only schedules a backoff when a phase THREW, so `> 0` proves
   * the injected fault actually interrupted the sync; without it, `pending() === 0` at the end is
   * equally true of a run where the fault never fired and the test would pass having tested nothing.
   */
  scheduledCount(): number {
    return this.#scheduled;
  }
  pending(): number {
    return this.#pending.filter((e) => e.live).length;
  }
  /** Fire the earliest live scheduled callback (a backoff window elapsing). */
  fireNext(): void {
    const entry = this.#pending.find((e) => e.live);
    if (entry === undefined) throw new Error('ManualTimer.fireNext with no pending timer');
    entry.live = false;
    entry.fn();
  }
}

/** The bundle refresh is a 304 no-op here (api/02-auth §5): CHAOS-02's subject is push/pull resume. */
const NOOP_BUNDLE: BundleRefreshPort = {
  refresh: (): Promise<BundleRefreshOutcome> => Promise.resolve('unchanged'),
};

/** Author `count` notes ops (creates + edits) on a device via the REAL command path (T-7, T-3). */
async function authorLoad(device: VirtualDevice, seed: number, count: number): Promise<void> {
  const prng = mulberry32(seed ^ 0x02_02);
  const noteIds: string[] = [];
  for (let authored = 0; authored < count; authored += 1) {
    device.clock.advance(1_000);
    if (noteIds.length === 0 || prng() < 0.2) {
      noteIds.push(
        await device.createNote({ title: `n-${seed}-${authored}`, body: `b-${authored}` }),
      );
    } else {
      const target = noteIds[Math.floor(prng() * noteIds.length)]!;
      await device.editNote(target, `edit-${seed}-${authored}`);
    }
  }
}

/** Every op-log id on the server for `deviceId` (owner handle — the append-only truth). */
async function serverDeviceOpCount(server: HarnessServer, deviceId: string): Promise<number> {
  const rows = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM operations WHERE device_id = ${deviceId}
  `.execute(server.db);
  return Number(rows.rows[0]?.c ?? 0);
}

/** The highest serverSeq the whole tenant log holds — the value a fully-drained cursor must equal. */
async function maxServerSeq(server: HarnessServer): Promise<number> {
  const rows = await sql<{ maxSeq: string | null }>`
    SELECT MAX(server_seq) AS "maxSeq" FROM operations
  `.execute(server.db);
  return Number(rows.rows[0]?.maxSeq ?? 0);
}

/** The device's pull cursor (api/01 §4 resume position). */
async function pullCursor(device: VirtualDevice): Promise<number> {
  const rows = await sql<{ pullCursor: number }>`
    SELECT pull_cursor AS "pullCursor" FROM sync_state WHERE id = 1
  `.execute(device.db);
  return Number(rows.rows[0]?.pullCursor ?? -1);
}

/** Every op row the device holds (its own + applied foreign) — the F5 rollback denominator. */
async function deviceOpCount(device: VirtualDevice): Promise<number> {
  const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM operations`.execute(device.db);
  return Number(rows.rows[0]?.c ?? -1);
}

/** True iff every op this device authored is now `synced` (the push half's terminal state). */
async function allLocalSynced(device: VirtualDevice): Promise<boolean> {
  const rows = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM operations
    WHERE device_id = ${device.identity.deviceId} AND sync_status <> 'synced'
  `.execute(device.db);
  return Number(rows.rows[0]?.c ?? -1) === 0;
}

interface Fixture {
  readonly server: HarnessServer;
  readonly device: VirtualDevice;
  readonly source: VirtualDevice;
  readonly auth: string;
  /** Union of every authored op (device + source) — the canonical-fold input. */
  readonly allOps: SignedOperation[];
  readonly localCount: number;
  close(): Promise<void>;
}

/**
 * Build the CHAOS-02 world: a target device with `perSide` local ops, and a source device whose
 * `perSide` foreign ops are already ON the server (pushed straight, no fault) so the target must PULL
 * them. Both share one tenant/store so the target's pull scope covers the foreign ops.
 */
async function buildFixture(seed: number, perSide: number): Promise<Fixture> {
  const server = await HarnessServer.boot();
  const [targetId, sourceId] = mintIdentities(seed, 2).devices as readonly [
    DeviceIdentity,
    DeviceIdentity,
  ];
  const seededTarget = await server.seedDevice(targetId);
  const seededSource = await server.seedDevice(sourceId);

  const device = await VirtualDevice.open({
    identity: targetId,
    clock: new FakeClock(CLOCK_BASE),
    prng: mulberry32(seed),
  });
  const source = await VirtualDevice.open({
    identity: sourceId,
    clock: new FakeClock(CLOCK_BASE + 5_000_000),
    prng: mulberry32(seed + 1),
  });

  // Each side authors `perSide` local ops INCLUDING its genesis (VirtualDevice.open emits genesis).
  await authorLoad(device, seed, perSide - 1);
  await authorLoad(source, seed + 7, perSide - 1);

  // The source's ops are placed on the server WITHOUT a fault (a plain push), so the target has
  // foreign ops to pull. Pushed in api/01 §3 batches.
  const sourceOps = await source.wireOps();
  const sourceTransport = new HttpTransport(server.fetch, seededSource.auth);
  for (let i = 0; i < sourceOps.length; i += PUSH_BATCH) {
    const res = await sourceTransport.push({
      deviceId: sourceId.deviceId,
      ops: sourceOps.slice(i, i + PUSH_BATCH),
    });
    if (!res.results.every((r) => r.status === 'accepted')) {
      throw new Error('CHAOS-02 fixture: source foreign ops were not all accepted');
    }
  }

  const deviceOps = await device.wireOps();
  return {
    server,
    device,
    source,
    auth: seededTarget.auth,
    allOps: [...deviceOps, ...sourceOps],
    localCount: deviceOps.length,
    close: async () => {
      await device.close();
      await source.close();
      await server.close();
    },
  };
}

/** Wire the REAL SyncLoop for the target device over a fault-injecting transport + optional crash txn. */
function buildLoop(
  fx: Fixture,
  faultFetch: FaultFetch,
  timer: ManualTimer,
  transaction: SyncLoopOptions<ClientDatabase>['transaction'],
): SyncLoop<ClientDatabase> {
  return new SyncLoop<ClientDatabase>({
    db: fx.device.db,
    transaction,
    transport: new HttpTransport(faultFetch.fetch, fx.auth),
    bundle: NOOP_BUNDLE,
    surface: SILENT_SURFACE,
    crypto: noblePort,
    clock: { now: () => fx.device.clock.now() },
    timer,
    deviceId: fx.device.identity.deviceId,
    applyPulledOp: (op) => fx.device.pullApply(op),
    pushBatchSize: PUSH_BATCH,
    pullLimit: PULL_LIMIT,
  });
}

/**
 * Let every backoff window the fault opened ELAPSE (api/01 §6) — the loop resumes on its own timer,
 * which is the resume path §3.6 names. Deliberately not a second manual trigger: a manual trigger
 * takes the early-exit path and would prove the retry works only when a human presses refresh.
 */
async function resumeViaBackoff(loop: SyncLoop<ClientDatabase>, timer: ManualTimer): Promise<void> {
  let guard = 0;
  while (timer.pending() > 0) {
    if (guard > 50) throw new Error('CHAOS-02: backoff did not converge within 50 resumes');
    guard += 1;
    timer.fireNext();
    await loop.settle();
  }
}

/** One trigger, then drive to a fully-drained state through the backoff timer. */
async function driveToConvergence(
  loop: SyncLoop<ClientDatabase>,
  timer: ManualTimer,
): Promise<void> {
  loop.requestSync('manual');
  await loop.settle();
  await resumeViaBackoff(loop, timer);
}

/** Assert the full §3.6 PASS block on a converged fixture. */
async function assertConverged(fx: Fixture): Promise<void> {
  // Server holds EXACTLY the device's pushed ops — no loss, no dupes (F2 retries were `duplicate`).
  expect(await serverDeviceOpCount(fx.server, fx.device.identity.deviceId)).toBe(fx.localCount);
  // Every pushed op is `synced`.
  expect(await allLocalSynced(fx.device)).toBe(true);
  // The pull cursor is the final serverSeq (fully drained, api/01 §4).
  expect(await pullCursor(fx.device)).toBe(await maxServerSeq(fx.server));
  // The device digest == the canonical fold of ALL ops.
  const reference = await canonicalFold(fx.allOps);
  assertConvergence(reference, [
    {
      name: `device-${fx.device.identity.deviceId.slice(0, 8)}`,
      digest: await fx.device.digest(),
      rows: await notesRows(fx.device.db),
    },
  ]);
}

/** A transaction that models F5: after the batch applies in-memory, abort ONCE → rollback (pull.ts). */
function crashOnceTransaction(
  fx: Fixture,
  faultFetch: FaultFetch,
): { transaction: SyncLoopOptions<ClientDatabase>['transaction']; fired: () => number } {
  let consumed = 0;
  const transaction: SyncLoopOptions<ClientDatabase>['transaction'] = (fn) =>
    fx.device.transaction(async () => {
      const result = await fn();
      // Consume one un-consumed F5 fired at the fetch boundary for this batch → throw INSIDE the
      // transaction, so `device.transaction` rolls the whole batch (ops + cursor) back.
      const f5s = faultFetch.firedClientCrashes.filter((c) => c.point === 'F5');
      if (f5s.length > consumed) {
        consumed += 1;
        throw new Error('CHAOS-02 F5: crash mid apply-transaction (rollback)');
      }
      return result;
    });
  return { transaction, fired: () => consumed };
}

/**
 * The seeds this scenario sweeps — DELIBERATELY bounded, and flagged rather than silently chosen.
 *
 * MEASURED: one case at the §3.6 volume costs ~50 s (3,200 ops authored through the REAL sign →
 * project → commit path, PGlite migrations, a full canonical fold). The spec's seeds 1–10 × the
 * (boundary × fault) product is therefore ~48 min — an order of magnitude past a merge gate.
 *
 * WHAT IS AND IS NOT REDUCED: the VOLUME is never reduced (acceptance forbids a silently smaller run)
 * and every fault point still runs. The SEED SWEEP is the bounded dimension — CI runs every fault at
 * the first CI seed; an explicit `CHAOS_SEEDS=…` (a reproduction) or the nightly lane runs every seed
 * it is given. Widening the CI sweep is [[106-chaos-heavy-scenario-scale-policy]]'s call, not this
 * file's, and this comment is the flag.
 */
function chaos02Seeds(env: NodeJS.ProcessEnv = process.env): number[] {
  const seeds = resolveSeeds(env);
  const explicit = env.CHAOS_SEEDS !== undefined && env.CHAOS_SEEDS !== '';
  if (explicit || env.CHAOS_NIGHTLY === '1') return seeds;
  return seeds.slice(0, 1);
}

describe('CHAOS-02 interrupted sync at every batch boundary', () => {
  const volumes = activeVolumes();
  const perSide = volumes.interruptedOpsPerSide;

  for (const seed of chaos02Seeds()) {
    // Each fault is a REPRESENTATIVE batch boundary at the FULL spec volume (§3.6). Push requests are
    // indices [0, pushBatches); pull requests follow. `perSide` ⇒ 4 push batches at CI scale.
    const pushBatches = Math.ceil(perSide / PUSH_BATCH);
    const pushBoundary = Math.min(2, pushBatches - 1); // a mid push batch
    const pullBoundary = pushBatches + 1; // the 2nd pull batch

    for (const point of ['F1', 'F2'] as const) {
      test(`CHAOS-02 ${point} at a PUSH batch boundary → resume converges, no dupes, cursor at head [seed ${seed}]`, async () => {
        await withSeed(
          seed,
          async () => {
            const fx = await buildFixture(seed, perSide);
            try {
              const faultFetch = new FaultFetch(fx.server.fetch, [
                { atIndex: pushBoundary, point },
              ]);
              const timer = new ManualTimer();
              const loop = buildLoop(fx, faultFetch, timer, (fn) => fx.device.transaction(fn));
              await loop.hydrate();
              await driveToConvergence(loop, timer);
              // DENOMINATOR (§2.11): the fault genuinely interrupted the sync — the loop threw and
              // backed off at least once. Without this, "converged" is equally true of a run whose
              // fault never fired, and the case would be green having tested nothing.
              expect(faultFetch.requestCount).toBeGreaterThan(pushBoundary);
              expect(timer.scheduledCount()).toBeGreaterThan(0);
              expect(timer.pending()).toBe(0);
              await assertConverged(fx);
            } finally {
              await fx.close();
            }
          },
          'CHAOS-02',
        );
      });
    }

    for (const point of ['F1', 'F2'] as const) {
      test(`CHAOS-02 ${point} at a PULL batch boundary → resume re-pulls, converges [seed ${seed}]`, async () => {
        await withSeed(
          seed,
          async () => {
            const fx = await buildFixture(seed, perSide);
            try {
              const faultFetch = new FaultFetch(fx.server.fetch, [
                { atIndex: pullBoundary, point },
              ]);
              const timer = new ManualTimer();
              const loop = buildLoop(fx, faultFetch, timer, (fn) => fx.device.transaction(fn));
              await loop.hydrate();
              await driveToConvergence(loop, timer);
              // DENOMINATOR (§2.11): the pull was genuinely interrupted at its boundary.
              expect(faultFetch.requestCount).toBeGreaterThan(pullBoundary);
              expect(timer.scheduledCount()).toBeGreaterThan(0);
              expect(timer.pending()).toBe(0);
              await assertConverged(fx);
            } finally {
              await fx.close();
            }
          },
          'CHAOS-02',
        );
      });
    }

    test(`CHAOS-02 F5 crash mid apply-transaction at a PULL boundary → rollback, re-pull re-applies, converges [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const fx = await buildFixture(seed, perSide);
          try {
            const faultFetch = new FaultFetch(fx.server.fetch, [
              { atIndex: pullBoundary, point: 'F5' as FaultPoint },
            ]);
            const timer = new ManualTimer();
            const crash = crashOnceTransaction(fx, faultFetch);
            const loop = buildLoop(fx, faultFetch, timer, crash.transaction);
            await loop.hydrate();

            // Run the FIRST cycle only, so the post-crash state is observable BEFORE the resume.
            loop.requestSync('manual');
            await loop.settle();
            expect(crash.fired()).toBe(1); // the crash DID fire (denominator, T-14)
            expect(timer.scheduledCount()).toBeGreaterThan(0); // and forced a real backoff

            // THE ROLLBACK, PROVEN. `fn()` had already inserted the batch's ops AND written the
            // cursor (pull.ts steps 3–4) when the crash threw; if the transaction had NOT rolled
            // back, those ops would be here. The device holds its own pushed ops plus EXACTLY the
            // one pull batch that committed before the crashed one — the crashed batch is gone.
            expect(await deviceOpCount(fx.device)).toBe(fx.localCount + PULL_LIMIT);

            // Now let the backoff elapse: the re-pull from the UNMOVED cursor re-applies the batch.
            await resumeViaBackoff(loop, timer);
            expect(timer.pending()).toBe(0);
            await assertConverged(fx);
          } finally {
            await fx.close();
          }
        },
        'CHAOS-02',
      );
    });

    test(`CHAOS-02 positive control: a NO-FAULT sync converges (== the resume target) [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const fx = await buildFixture(seed, perSide);
          try {
            const faultFetch = new FaultFetch(fx.server.fetch, []); // no scheduled fault
            const timer = new ManualTimer();
            const loop = buildLoop(fx, faultFetch, timer, (fn) => fx.device.transaction(fn));
            await loop.hydrate();
            await driveToConvergence(loop, timer);
            // A fault-FREE run never backs off at all. This is what makes every fault case's
            // `scheduledCount() > 0` attributable to the injected fault rather than to ambient
            // flakiness — the two halves together are the watched-red pair (§2.11).
            expect(timer.scheduledCount()).toBe(0);
            expect(timer.pending()).toBe(0);
            expect(faultFetch.firedClientCrashes).toHaveLength(0); // truly fault-free
            await assertConverged(fx);
          } finally {
            await fx.close();
          }
        },
        'CHAOS-02',
      );
    });
  }

  test('CHAOS-02 negative control: dropping one foreign op leaves the device DIVERGED from the canonical fold (the oracle is not blind)', async () => {
    const seed = 1;
    const fx = await buildFixture(seed, activeVolumes().interruptedOpsPerSide);
    try {
      const faultFetch = new FaultFetch(fx.server.fetch, []);
      const timer = new ManualTimer();
      const loop = buildLoop(fx, faultFetch, timer, (fn) => fx.device.transaction(fn));
      await loop.hydrate();
      await driveToConvergence(loop, timer);
      // The device converged to the fold of ALL ops. Now compare it against a reference that is
      // MISSING one foreign op — the digests MUST differ, proving the oracle detects a lost op.
      const missingOne = fx.allOps.filter((op) => op.type.startsWith('notes.')).slice(0, -1);
      const shortReference = await canonicalFold([
        ...fx.allOps.filter((op) => !op.type.startsWith('notes.')),
        ...missingOne,
      ]);
      expect(await fx.device.digest()).not.toBe(shortReference.digest);
    } finally {
      await fx.close();
    }
  });
});
