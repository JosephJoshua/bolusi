// CHAOS-03 days-offline bulk merge, the SERVER-ROUND-TRIP half of the convergence rig (testing-guide
// §3.6 / FR-1123) — the shared, platform-free body the on-device runner and the host watched-RED test
// both drive (task 198). Unlike `runConvergence` (CHAOS-01, client-only: devices cross-feed in-process
// via `applyForeign`), this run reconnects each device to a REAL `@bolusi/server` and syncs over the
// wire through the production push+pull phases (`pushDevice`/`pullDevice`, transport.js — never
// re-implemented, T-7).
//
// ── ONE RIG, TWO BINDINGS (§2.8), extended to the server seam ─────────────────────────────────────
// The SERVER is injected, exactly as the DB engine is: `Chaos03Net` carries a `FetchLike` + the per-
// device bearer tokens. On the host test that fetch is `socketBaseFetch(startHarnessServer().url)` (a
// real loopback socket to the in-process `@bolusi/server`); on device it is the RN global `fetch` over
// `10.0.2.2` / `adb reverse` to the laptop harness (§2.6). The devices are minted deterministically by
// `mintIdentities(seed, n)` on BOTH sides, so the host driver seeds those exact public keys and hands
// the bearers back in mint order — index `i` here pairs with `net.auth[i]`. Neither this file nor the
// bindings re-implement the fold, the transport, or the verdict.
//
// ── EVERY ASSERTION IS CLIENT-OBSERVABLE ──────────────────────────────────────────────────────────
// A device cannot read `server.db` (the Node scenario's `serverSeqById`/`serverConflicts`). So the
// §3.6 properties are witnessed only through client-side signal:
//   CONVERGENCE — `canonicalFold` over the notes universe the CLIENTS authored (§3.4 oracle) vs each
//                 device's post-merge digest; a lost op leaves a device DIVERGED.
//   THRESHOLD   — every device folded foreign ops over the wire (`PullPhaseResult.applied` > 0) and
//                 actually had foreign notes to fold; a run that merged nothing is INCONCLUSIVE, never
//                 a pass (§2.11 / task 198 Acceptance).
//   INCREMENTAL — a redundant final sync applies 0 AND pulls an EMPTY page (`CountingTransport`
//                 witness): the cursor reached head, so pull is incremental, not a re-download. This
//                 is genesis-agnostic — it holds no matter how a foreign `auth.device_enrolled` op
//                 folds — which is why the runner does NOT try to predict an exact applied-op count
//                 from the client side (it cannot see the server's op log).
// `evaluateChaos03` turns those observations into ONE verdict both bindings share — so a green on
// device means exactly what a green in the host test means.
//
// PLATFORM/DOMAIN-FREE (task 181): reaches no `node:` builtin — `noblePort` arrives through the sibling
// transport.js, the determinism leaves through `../determinism/*`. `chaos-bundle-safe.test.ts` guards it.
import type { SyncTransportPort } from '@bolusi/core';
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';

import { FakeClock } from '../determinism/clock.js';
import { mulberry32, randomInt, type Prng } from '../determinism/prng.js';

import { VirtualDevice } from './device.js';
import { mintIdentities } from './identities.js';
import { canonicalFold, notesRows, type NotesRow } from './oracle.js';
import type { ConvergenceSeams } from './seams.js';
import { HttpTransport, pullDevice, pushDevice, type FetchLike } from './transport.js';

const CLOCK_BASE = 1_726_100_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const NOTES_CREATED = 'notes.note_created';
const DEFAULT_PUSH_BATCH = 500; // api/01 §3 cap.
const DEFAULT_PULL_LIMIT = 500;
/** Share of each device's ops authored as edits on the pre-shared pool (cross-device contention); the
 *  rest are own-note creates. Mirrors the Node scenario's edit weighting so the merge is a same-entity
 *  re-fold, not disjoint creates. */
const EDIT_FRACTION = 0.15;

/** The options the on-device runner and the host test share — a DEVICE-appropriate reduction of the
 *  §3.6 spec volume (the full 4×7×opsPerDay sweep stays the Node scenario's job), sized so a single
 *  low-end Android finishes within the harness budget while still forcing a real cross-device merge. */
export interface Chaos03Options {
  readonly deviceCount: number;
  readonly opsPerDevice: number;
  readonly sharedNotes: number;
  readonly pushBatch?: number;
  readonly pullLimit?: number;
  /** Positive control (WATCHED RED): drop one foreign `note_created` op from device 0's merge pull so
   *  device 0 MUST diverge from the canonical fold while every untouched device converges — proving
   *  "converged" means every op arrived, not that the oracle is blind (§2.11). Dropping a CREATE (not
   *  an arbitrary op) guarantees divergence: the reference holds that entity, the starved device does
   *  not, so no last-writer-wins accident can mask the loss. */
  readonly dropFromDevice0?: boolean;
}

export const DEFAULT_CHAOS03_OPTIONS: Chaos03Options = {
  deviceCount: 3,
  opsPerDevice: 120,
  sharedNotes: 20,
};

/** A fixed seed so the on-device run is deterministic and reproducible (the PRNG is fully seeded). */
export const DEFAULT_CHAOS03_SEED = 203;

/** The server seam: a `fetch` to the host `@bolusi/server` + the bearer per device, in `mintIdentities`
 *  order (index `i` ↔ device `i`). The host driver seeds those keys out-of-band and hands these back. */
export interface Chaos03Net {
  readonly fetch: FetchLike;
  readonly auth: readonly string[];
}

/** Per-device observations — all client-side, the whole basis for the verdict. */
export interface Chaos03DeviceObs {
  readonly name: string;
  /** Ops this device pushed on its pass-1 reconnect (its own locals: genesis + authored notes). */
  readonly localPushed: number;
  /** Push requests pass-1 split into — the ≤500/batch witness (⌈localPushed / pushBatch⌉). */
  readonly pushBatches: number;
  /** Foreign ops this device folded over the wire across every merge pass (the merge witness). >0 or
   *  the run is INCONCLUSIVE for this device. */
  readonly foreignApplied: number;
  /** Foreign NOTES ops available to this device = notes universe − notes it already held. The "was
   *  there anything to merge" denominator; 0 ⇒ trivial convergence ⇒ INCONCLUSIVE. */
  readonly foreignNotesAvailable: number;
  /** A redundant final sync must fold nothing… */
  readonly redundantApplied: number;
  /** …AND pull an empty page over the wire — the cursor is at head, not a re-download. */
  readonly redundantWirePulled: number;
}

export interface Chaos03Result {
  readonly reference: { readonly digest: string; readonly rows: NotesRow[] };
  readonly replicas: readonly {
    readonly name: string;
    readonly digest: string;
    readonly rows: NotesRow[];
  }[];
  readonly devices: readonly Chaos03DeviceObs[];
  /** The op id the drop control removed (null when the control is off, or if it saw no create — a
   *  broken control that dropped nothing, which the host test asserts against). */
  readonly droppedOpId: string | null;
  close(): Promise<void>;
}

/** A per-device authoring PRNG, distinct per (run seed, device index). Mirrors the Node scenario. */
function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e37_79b1) ^ Math.imul(index + 1, 0x85eb_ca77)) >>> 0;
}

/** Only notes ops fold into the projection; the per-device genesis enroll op is not folded. */
function notesOnly(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.filter((op) => op.type.startsWith('notes.'));
}

function dedupeById(ops: readonly SignedOperation[]): SignedOperation[] {
  const byId = new Map<string, SignedOperation>();
  for (const op of ops) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}

/**
 * A `SyncTransportPort` wrapping the production `HttpTransport` to record the wire counts the
 * incremental-pull property is witnessed by: every pull response's op count (and every push's, for
 * symmetry). Adds NO protocol logic (T-7) — counts + delegates. (The Node scenario keeps a private
 * twin; this is the shared home a future refactor can dedupe it against — the task keeps that scenario
 * untouched, so the 2nd copy is deliberate, not drift.)
 */
class CountingTransport implements SyncTransportPort {
  readonly pushOpCounts: number[] = [];
  readonly pullOpCounts: number[] = [];
  constructor(private readonly inner: SyncTransportPort) {}

  push(request: PushRequest): Promise<PushResponse> {
    this.pushOpCounts.push(request.ops.length);
    return this.inner.push(request);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const response = await this.inner.pull(request);
    this.pullOpCounts.push(response.ops.length);
    return response;
  }

  pulledSinceReset(): number {
    return this.pullOpCounts.reduce((a, b) => a + b, 0);
  }
  reset(): void {
    this.pushOpCounts.length = 0;
    this.pullOpCounts.length = 0;
  }
}

/**
 * A pull wrapper that drops the FIRST `note_created` op it sees (by id) from that response and every
 * later one — the merge-boundary loss the positive control needs. The cursor still advances past the
 * dropped op (we preserve `nextCursor`), so it is NEVER re-served: the device is permanently short one
 * create and DIVERGES, exactly the silent-loss a healthy oracle must catch. Push is delegated verbatim.
 * Records the dropped id (null if it never saw a create) so a control that dropped nothing is caught.
 */
class DroppingPullTransport implements SyncTransportPort {
  droppedId: string | null = null;
  constructor(private readonly inner: SyncTransportPort) {}

  push(request: PushRequest): Promise<PushResponse> {
    return this.inner.push(request);
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    const response = await this.inner.pull(request);
    if (this.droppedId === null) {
      const victim = response.ops.find((op) => op.type === NOTES_CREATED);
      if (victim !== undefined) this.droppedId = victim.id;
    }
    if (this.droppedId === null) return response;
    return { ...response, ops: response.ops.filter((op) => op.id !== this.droppedId) };
  }
}

/** A full sync = the REAL push phase then the REAL pull-until-drained phase (transport.js, T-7). */
async function fullSync(
  device: VirtualDevice,
  transport: SyncTransportPort,
  pushBatch: number,
  pullLimit: number,
): Promise<{ pushed: number; pushBatches: number; applied: number }> {
  const push = await pushDevice(device, transport, { batchSize: pushBatch });
  const pull = await pullDevice(device, transport, { limit: pullLimit });
  return { pushed: push.synced, pushBatches: push.batches, applied: pull.applied };
}

/**
 * Author exactly `count` LOCAL ops on `device`, advancing the FakeClock by ~`stepMs`/op so the run
 * spans its intended offline window. `EDIT_FRACTION` are edits on the shared pool (cross-device
 * contention); the rest are own-note creates.
 */
async function authorOffline(
  device: VirtualDevice,
  prngSeed: number,
  count: number,
  stepMs: number,
  sharedIds: readonly string[],
): Promise<void> {
  const prng: Prng = mulberry32(prngSeed ^ 0x5bd1_e995);
  const short = device.identity.deviceId.slice(0, 6);
  const step = Math.max(2, Math.floor(stepMs));
  for (let k = 0; k < count; k += 1) {
    device.clock.advance(randomInt(prng, 1, step));
    if (sharedIds.length > 0 && prng() < EDIT_FRACTION) {
      const target = sharedIds[randomInt(prng, 0, sharedIds.length - 1)]!;
      await device.editNote(target, `edit-${short}-${k}`);
    } else {
      await device.createNote({ title: `own-${short}-${k}`, body: `b-${k}` });
    }
  }
}

interface DeviceRun {
  readonly device: VirtualDevice;
  readonly transport: CountingTransport;
  readonly foreignNotesAvailable: number;
}

/**
 * Run the CHAOS-03 days-offline bulk merge over the injected server seam and return every client-side
 * observation the verdict rests on. Structure (mirrors the Node scenario, T-7):
 *   setup  — device 0 creates a shared pool, delivered OFFLINE to every device (so cross-device edits
 *            have a target); then each device authors ops OFFLINE (device 0 authors the remainder of
 *            its budget after the pool).
 *   pass 1 — reconnect one at a time: each device pushes its locals (≤500/batch) then pulls what is
 *            above its cursor (the ops of devices that reconnected earlier).
 *   pass 2 — MERGE: each device pulls the rest. Device 0's pass-2 pull is where the drop control bites.
 *   pass 3 — redundant: a second sync must apply 0 AND pull an empty page (cursor incrementality).
 */
export async function runChaos03(
  seed: number,
  options: Chaos03Options,
  seams: ConvergenceSeams,
  net: Chaos03Net,
): Promise<Chaos03Result> {
  const { deviceCount, opsPerDevice, sharedNotes } = options;
  const pushBatch = options.pushBatch ?? DEFAULT_PUSH_BATCH;
  const pullLimit = options.pullLimit ?? DEFAULT_PULL_LIMIT;
  if (net.auth.length !== deviceCount) {
    throw new Error(
      `CHAOS-03 net handoff has ${net.auth.length} bearers but the run needs ${deviceCount} (one per device)`,
    );
  }

  const ids = mintIdentities(seed, deviceCount);
  const devices = await Promise.all(
    ids.devices.map((identity, index) =>
      VirtualDevice.open(
        {
          identity,
          clock: new FakeClock(CLOCK_BASE + index),
          prng: mulberry32(deviceSeed(seed, index)),
        },
        seams,
      ),
    ),
  );

  // Setup — device 0 creates the shared pool (part of its budget) and delivers those creates OFFLINE.
  const poolPrng = mulberry32(seed ^ 0x9001);
  const sharedIds: string[] = [];
  for (let n = 0; n < sharedNotes; n += 1) {
    devices[0]!.clock.advance(randomInt(poolPrng, 1, 60_000));
    sharedIds.push(
      await devices[0]!.createNote({ title: `shared-${seed}-${n}`, body: `pool-${n}` }),
    );
  }
  const sharedCreates = notesOnly(await devices[0]!.wireOps()).filter(
    (op) => op.type === NOTES_CREATED && sharedIds.includes(op.entityId),
  );
  for (let d = 1; d < deviceCount; d += 1) {
    for (const op of sharedCreates) await devices[d]!.applyForeign(op);
  }

  // Offline authoring — device 0 authors the remainder of its budget; devices 1..n the full budget.
  const stepMs = DAY_MS / opsPerDevice;
  await authorOffline(
    devices[0]!,
    deviceSeed(seed, 0),
    opsPerDevice - sharedNotes,
    stepMs,
    sharedIds,
  );
  for (let d = 1; d < deviceCount; d += 1) {
    await authorOffline(devices[d]!, deviceSeed(seed, d), opsPerDevice, stepMs, sharedIds);
  }

  // Client-side denominators (§3.6) — from the devices' OWN wire ops, before any sync.
  const perDevice = await Promise.all(devices.map((dev) => dev.wireOps()));
  const heldNotesCount = perDevice.map((ops) => dedupeById(notesOnly(ops)).length);
  const notesUniverse = dedupeById(perDevice.flatMap((ops) => notesOnly(ops)));
  const foreignNotesAvailable = heldNotesCount.map((held) => notesUniverse.length - held);

  const runs: DeviceRun[] = devices.map((device, index) => ({
    device,
    transport: new CountingTransport(new HttpTransport(net.fetch, net.auth[index]!)),
    foreignNotesAvailable: foreignNotesAvailable[index]!,
  }));

  const appliedTotal = new Array<number>(deviceCount).fill(0);
  const pass1Push = new Array<{ pushed: number; batches: number }>(deviceCount);

  // Pass 1 — reconnect one at a time.
  for (let d = 0; d < deviceCount; d += 1) {
    const r = await fullSync(runs[d]!.device, runs[d]!.transport, pushBatch, pullLimit);
    appliedTotal[d]! += r.applied;
    pass1Push[d] = { pushed: r.pushed, batches: r.pushBatches };
  }

  // Pass 2 — MERGE. Device 0 pulls through the dropping transport when the control is on.
  const dropper =
    options.dropFromDevice0 === true ? new DroppingPullTransport(runs[0]!.transport) : null;
  for (let d = 0; d < deviceCount; d += 1) {
    const transport = d === 0 && dropper !== null ? dropper : runs[d]!.transport;
    const r = await fullSync(runs[d]!.device, transport, pushBatch, pullLimit);
    appliedTotal[d]! += r.applied;
  }

  // Pass 3 — redundant: nothing to push, an empty pull page, zero applied.
  const redundant = new Array<{ applied: number; wirePulled: number }>(deviceCount);
  for (let d = 0; d < deviceCount; d += 1) {
    runs[d]!.transport.reset();
    const r = await fullSync(runs[d]!.device, runs[d]!.transport, pushBatch, pullLimit);
    redundant[d] = { applied: r.applied, wirePulled: runs[d]!.transport.pulledSinceReset() };
  }

  const reference = await canonicalFold(notesUniverse, seams);
  const replicas = await Promise.all(
    devices.map(async (device, index) => ({
      name: `device-${index}`,
      digest: await device.digest(),
      rows: await notesRows(device.db),
    })),
  );

  const deviceObs: Chaos03DeviceObs[] = devices.map((_, d) => ({
    name: `device-${d}`,
    localPushed: pass1Push[d]!.pushed,
    pushBatches: pass1Push[d]!.batches,
    foreignApplied: appliedTotal[d]!,
    foreignNotesAvailable: runs[d]!.foreignNotesAvailable,
    redundantApplied: redundant[d]!.applied,
    redundantWirePulled: redundant[d]!.wirePulled,
  }));

  return {
    reference,
    replicas,
    devices: deviceObs,
    droppedOpId: dropper?.droppedId ?? null,
    close: async () => {
      for (const device of devices) await device.close();
    },
  };
}

/** The single verdict both bindings share. INCONCLUSIVE (a run that never crossed the merge threshold)
 *  and DIVERGENCE (a device whose digest ≠ the canonical fold) are BOTH `ok: false` — never pass on an
 *  inconclusive (§2.11 / task 198 Acceptance). */
export interface Chaos03Verdict {
  readonly ok: boolean;
  readonly inconclusive: boolean;
  readonly reason: string;
  readonly metrics: {
    readonly devices: number;
    readonly opsPerDevice: number;
    readonly foreignApplied: number;
    readonly converged: number;
  };
}

export function evaluateChaos03(result: Chaos03Result, options: Chaos03Options): Chaos03Verdict {
  const totalForeignApplied = result.devices.reduce((t, d) => t + d.foreignApplied, 0);
  const converged = result.replicas.filter((r) => r.digest === result.reference.digest).length;
  const metrics = {
    devices: options.deviceCount,
    opsPerDevice: options.opsPerDevice,
    foreignApplied: totalForeignApplied,
    converged,
  } as const;
  const fail = (reason: string, inconclusive = false): Chaos03Verdict => ({
    ok: false,
    inconclusive,
    reason,
    metrics,
  });

  // INCONCLUSIVE first: a device with no foreign notes to fold, or that folded nothing over the wire,
  // never exercised the merge — so a "converged" reading proves nothing and must not read as green.
  for (const d of result.devices) {
    if (d.foreignNotesAvailable <= 0) {
      return fail(
        `INCONCLUSIVE: ${d.name} had no foreign notes to fold — the cross-device merge never crossed ` +
          `the threshold, so convergence proves nothing (§2.11).`,
        true,
      );
    }
    if (d.foreignApplied <= 0) {
      return fail(
        `INCONCLUSIVE: ${d.name} folded 0 foreign ops over the wire despite ${d.foreignNotesAvailable} ` +
          `available — the merge never ran for it (§2.11).`,
        true,
      );
    }
  }

  // DIVERGENCE: the drop control (and any real lost-op bug) surfaces here.
  const diverged = result.replicas.filter((r) => r.digest !== result.reference.digest);
  if (diverged.length > 0) {
    return fail(
      `${diverged.map((r) => r.name).join(', ')} DIVERGED from the canonical fold ` +
        `(reference ${result.reference.digest.slice(0, 12)}…) — a foreign op did not survive the merge.`,
    );
  }

  // INCREMENTAL PULL: a redundant sync must move nothing at BOTH the fold level and the wire — the
  // cursor is at head, so pull is incremental, not a full re-download.
  for (const d of result.devices) {
    if (d.redundantApplied !== 0 || d.redundantWirePulled !== 0) {
      return fail(
        `${d.name} re-served ${d.redundantWirePulled} ops / re-applied ${d.redundantApplied} on a ` +
          `redundant sync — the cursor is not at head, so pull is a re-download, not incremental.`,
      );
    }
  }

  return {
    ok: true,
    inconclusive: false,
    reason:
      `${metrics.devices} devices authored ${metrics.opsPerDevice} ops offline, reconnected one at a ` +
      `time, and converged to the canonical fold over the wire (${converged}/${result.replicas.length} ` +
      `replicas; ${totalForeignApplied} foreign ops folded, empty redundant pull).`,
    metrics,
  };
}
