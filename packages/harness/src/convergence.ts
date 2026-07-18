// The multi-device convergence run CHAOS-01 (and CHAOS-03) drive (§3.6). Devices author OFFLINE
// through the production command path, then every device receives every other device's ops in a
// PRNG-shuffled arrival order and folds them through the REAL engine's pull path. Convergence is
// the oracle's job (§3.4); this file only orchestrates the disorder.
//
// WHY A PRE-SHARED POOL. `editNoteBody` reads the note through the query layer (04 §5.2) and throws
// `ENTITY_NOT_FOUND` for a note the authoring device does not hold — so genuine cross-device
// same-entity contention requires the target note to exist on every device BEFORE the offline
// phase. Device 0 creates a shared pool and its creates are delivered to all devices; the offline
// edits then collide on those shared notes (the re-fold pressure §4.2 needs), exactly the "3 devices
// share one synced note, all go offline, each edits it" shape (CHAOS-07 setup, generalized).
import { shuffle, FakeClock, mulberry32, randomInt, type Prng } from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';

import { VirtualDevice } from './device.js';
import { mintIdentities } from './identities.js';
import { canonicalFold, type NotesRow } from './oracle.js';
import { notesRows } from './oracle.js';

const CLOCK_BASE = 1_726_100_000_000;
const NOTES_CREATED = 'notes.note_created';

/** Only the notes ops matter to the projection; genesis enroll ops are per-device and not folded. */
function notesOnly(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.filter((op) => op.type.startsWith('notes.'));
}

/** A per-device PRNG seed, distinct per (run seed, device). */
function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;
}

export interface ConvergenceOptions {
  readonly opsPerDevice: number;
  readonly deviceCount: number;
  readonly sharedNotes: number;
  /** Arrival order of the cross-feed: shuffled (the real case) or canonical (a positive control). */
  readonly delivery: 'shuffled' | 'canonical';
  /** Positive control: drop this many ops from device 0's cross-feed (forces divergence). */
  readonly dropFromDevice0?: number;
}

export interface ConvergenceResult {
  readonly devices: readonly VirtualDevice[];
  readonly reference: { digest: string; rows: NotesRow[] };
  readonly replicas: readonly { name: string; digest: string; rows: NotesRow[] }[];
  /** Per-device engine stats after the cross-feed — the both-fold-paths witness. */
  readonly stats: readonly { name: string; headApplies: number; refolds: number }[];
  close(): Promise<void>;
}

/** Run a full convergence scenario and return every replica's digest + the reference. */
export async function runConvergence(
  seed: number,
  options: ConvergenceOptions,
): Promise<ConvergenceResult> {
  const { opsPerDevice, deviceCount, sharedNotes } = options;
  const ids = mintIdentities(seed, deviceCount);
  const devices = await Promise.all(
    ids.devices.map((identity, index) =>
      VirtualDevice.open({
        identity,
        clock: new FakeClock(CLOCK_BASE + index),
        prng: mulberry32(deviceSeed(seed, index)),
      }),
    ),
  );

  // Phase 1 — device 0 creates the shared pool; deliver those creates to every other device.
  const poolPrng = mulberry32(seed);
  const sharedIds: string[] = [];
  for (let n = 0; n < sharedNotes; n += 1) {
    devices[0]!.clock.advance(randomInt(poolPrng, 1_000, 600_000));
    sharedIds.push(
      await devices[0]!.createNote({
        title: `shared-${seed}-${n}`,
        body: `seed-${seed}-pool-${n}`,
      }),
    );
  }
  const sharedCreates = notesOnly(await devices[0]!.wireOps()).filter(
    (op) => op.type === NOTES_CREATED && sharedIds.includes(op.entityId),
  );
  for (let d = 1; d < deviceCount; d += 1) {
    for (const op of sharedCreates) await devices[d]!.applyForeign(op);
  }

  // Phase 2 — each device authors offline: mostly concurrent edits on the shared pool (contention),
  // some own-note creates (creation interleaving). No archives — archive is terminal and a second
  // archive/an edit-after-archive is a command-level INVALID_TRANSITION, which is CHAOS-07's subject.
  for (let d = 0; d < deviceCount; d += 1) {
    const prng = mulberry32(deviceSeed(seed, d) ^ 0x5bd1e995);
    for (let k = 0; k < opsPerDevice; k += 1) {
      devices[d]!.clock.advance(randomInt(prng, 1_000, 600_000));
      if (prng() < 0.85) {
        const target = pickTarget(prng, sharedIds);
        await devices[d]!.editNote(target, `edit-${seed}-${d}-${k}`);
      } else {
        await devices[d]!.createNote({
          title: `own-${seed}-${d}-${k}`,
          body: `own-${seed}-${d}-${k}`,
        });
      }
    }
  }

  // Phase 3 — cross-feed: every device receives every op it lacks, in shuffled (or canonical) order.
  const collected: SignedOperation[] = [];
  for (const device of devices) collected.push(...notesOnly(await device.wireOps()));
  const universe = dedupeById(collected);

  for (let d = 0; d < deviceCount; d += 1) {
    const device = devices[d]!;
    const held = new Set((await device.wireOps()).map((op) => op.id));
    let toDeliver = universe.filter((op) => !held.has(op.id));
    toDeliver =
      options.delivery === 'canonical'
        ? sortByCanonical(toDeliver)
        : shuffle(mulberry32(deviceSeed(seed, d) ^ 0xcafebabe), toDeliver);
    if (d === 0 && options.dropFromDevice0 !== undefined && options.dropFromDevice0 > 0) {
      toDeliver = toDeliver.slice(options.dropFromDevice0); // drop the first N — forces divergence
    }
    for (const op of toDeliver) await device.applyForeign(op);
  }

  const reference = await canonicalFold(universe);
  const replicas = await Promise.all(
    devices.map(async (device, index) => ({
      name: `device-${index}`,
      digest: await device.digest(),
      rows: await notesRows(device.db),
    })),
  );
  const stats = devices.map((device, index) => ({
    name: `device-${index}`,
    headApplies: device.stats.snapshot().headApplies,
    refolds: device.stats.snapshot().refolds,
  }));

  return {
    devices,
    reference,
    replicas,
    stats,
    close: async () => {
      for (const device of devices) await device.close();
    },
  };
}

function pickTarget(prng: Prng, ids: readonly string[]): string {
  // Uniform over the shared pool. Every note is edited by MULTIPLE devices (the same-entity
  // contention CHAOS-01 needs), while spreading edits keeps per-entity history — and therefore
  // re-fold cost (04 §4.2 deletes + re-folds an entity's whole history) — bounded. A recency clump
  // onto a handful of notes made the re-fold quadratic without adding convergence signal.
  return ids[randomInt(prng, 0, ids.length - 1)]!;
}

function dedupeById(ops: readonly SignedOperation[]): SignedOperation[] {
  const byId = new Map<string, SignedOperation>();
  for (const op of ops) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}

function sortByCanonical(ops: readonly SignedOperation[]): SignedOperation[] {
  return [...ops].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return a.seq - b.seq;
  });
}
