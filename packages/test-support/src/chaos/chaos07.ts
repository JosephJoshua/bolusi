// CHAOS-07 concurrent same-entity edits + edit-after-archive, over the SERVER round trip (testing-guide
// §3.6; classification per 01-domain-model §8) — the shared, platform-free body the on-device runner and
// the host watched-RED test both drive (task 198). Where the Node scenario chaos-07-conflicts.test.ts
// reads `server.db` directly and hand-feeds each server-minted op into a device with `applyForeign` (the
// engine fold, NO signature check), THIS rig is the dual: a device cannot read the server DB, so it PULLS
// every op — member edits AND the system's `platform.conflict_detected` — over the wire, through the real
// verify-and-quarantine pull path (sync/pull.ts). That is the stronger integration claim, and the reason
// leg 2's surfacing is witnessed only through client-observable signal.
//
// ── ONE RIG, TWO BINDINGS (§2.8), extended to the server seam ─────────────────────────────────────
// Same shape as chaos03.ts / chaos06.ts: the SERVER is injected as `Chaos07Net` (a `FetchLike` + one
// bearer per device, in `mintIdentities` order). On the host test that fetch is
// `socketBaseFetch(startHarnessServer({systemKeyStore,...}).url)` (a real loopback socket to an
// in-process `@bolusi/server` with conflict detection ON + a seeded system device); on device it is the
// RN global `fetch` over `10.0.2.2` / `adb reverse` (§2.6). Detection, the system device, and the system
// signing key are all HOST-side setup the driver does BEFORE calling `runChaos07` — the rig only drives
// member devices, exactly as the net-handoff model for 03/06 (T-7: no forked detector).
//
// ── WHAT THE DEVICE OBSERVES (every assertion client-observable) ───────────────────────────────────
//   LEG 1 — concurrent edits (§3.6 (i)): A, B, C each edit ONE shared synced note offline at distinct
//     timestamps, then push + pull-drain. The server mints Rule-1 `{note.body, minor}` conflicts, which
//     rest `auto_resolved` and never surface (03 §7) — so leg 1 is judged purely on the NOTES projection:
//     every device converges (byte-equal notes digest) and the surviving body is the canonical LWW winner
//     `(timestamp ASC, deviceId ASC, seq ASC)` last edit (05 §4). The winner is computed by an INDEPENDENT
//     explicit sort over the competing edit wire-ops (never `canonicalFold`), so the check is a real
//     cross-check on the engine's fold, not a tautology; the `reverseWinnerOracle` control perturbs that
//     sort to prove it load-bearing (the task-38 tiebreak-guard pattern).
//   LEG 2 — edit-after-archive (§3.6 (iii)): A archives a second synced note (and syncs) while B — offline
//     through the archive — edits its body. Rule 2's `notes:edit_after_archive` fires at the server →
//     a SIGNIFICANT `{note.archived}` conflict → `surfaced`. B then PULLS the `platform.conflict_detected`
//     op and folds it, so B's OWN `conflicts` projection shows the significant conflict `surfaced` — the
//     client-observable half of "surfaced on every device". The edit stands and the note stays archived
//     (03 §11's total rule). SCOPE: this leg proves DETECTION + SURFACING on the device, not the
//     `surfaced → acknowledged` walk — the acknowledgment op needs an author the shared VirtualDevice does
//     not expose, and its full D4 transition coverage stays the Node scenario's job (§2.11: no false
//     "full transition" claim). "Never surfaced" is the INCONCLUSIVE case task 198 names.
//
// `evaluateChaos07` turns those observations into ONE verdict both bindings share — a green on device
// means exactly what a green in the host test means. INCONCLUSIVE (a dead pull path, or (iii) never
// surfaced) and a RED (divergence, a wrong LWW winner, a detected-but-not-surfaced fold) are BOTH
// `ok: false` — never pass on an inconclusive run (§2.11 / task 198 Acceptance).
//
// PLATFORM/DOMAIN-FREE (task 181): reaches no `node:` builtin — `@bolusi/core`'s `platform` module runs
// on Hermes (it is the production engine the device already folds through), `noblePort` arrives via the
// sibling transport.js, `kysely`'s `sql` is the on-device query builder. `chaos-bundle-safe.test.ts`
// guards the no-`node:` claim.
import { PLATFORM_OP, platformModule, platformModuleManifest } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { sql } from 'kysely';

import { FakeClock } from '../determinism/clock.js';
import { mulberry32 } from '../determinism/prng.js';

import { VirtualDevice, type ExtraModule } from './device.js';
import { mintIdentities } from './identities.js';
import { notesRows, type NotesRow } from './oracle.js';
import type { ConvergenceSeams } from './seams.js';
import { HttpTransport, pullDevice, pushDevice, type FetchLike } from './transport.js';

const CLOCK_BASE = 1_726_100_000_000;
const DEFAULT_PUSH_BATCH = 60; // well under the api/01 §3 cap of 500.
const DEFAULT_PULL_LIMIT = 500;

const NOTE_CREATED = 'notes.note_created';
const NOTE_EDITED = 'notes.note_body_edited';

/** Three devices: A/B/C edit the shared note (leg 1); A + B also drive edit-after-archive (leg 2). C is
 *  not part of leg 2 but still pulls note-2's ops (store-wide pull scope), so it converges on both. */
export const CHAOS07_DEVICE_COUNT = 3;

/** Register `platform` on each device so it can fold the server-minted `platform.conflict_detected` op
 *  into its `conflicts` projection (04 §5.1). The cast mirrors the Node scenario's — `platformModule`'s
 *  db generic is the server flavour, structurally identical to the client one the rig registers. */
const platformExtra = {
  module: platformModule,
  permissionManifest: platformModuleManifest,
} as unknown as ExtraModule;

/** The server seam: a `fetch` to the host `@bolusi/server` + one bearer per device in `mintIdentities`
 *  order (index `i` ↔ device `i`). The host driver seeds those keys AND the system device out-of-band and
 *  hands these bearers back; the rig never sees the system key. */
export interface Chaos07Net {
  readonly fetch: FetchLike;
  readonly auth: readonly string[];
}

export interface Chaos07Options {
  readonly pushBatch?: number;
  readonly pullLimit?: number;
  /** Negative control (WATCHED RED): reverse the winner oracle's canonical sort so it expects the FIRST
   *  edit, not the canonical `(timestamp,deviceId,seq)` LAST. The devices still fold correctly, so the
   *  converged body no longer matches the (now-wrong) oracle → `evaluateChaos07` must return a RED. Proves
   *  the winner comparison is load-bearing, not a tautology (§2.11). */
  readonly reverseWinnerOracle?: boolean;
}

export const DEFAULT_CHAOS07_OPTIONS: Chaos07Options = { pushBatch: DEFAULT_PUSH_BATCH };

/** A fixed seed so the on-device run is deterministic and reproducible (T-6). */
export const DEFAULT_CHAOS07_SEED = 207;

/** The client-side observations the verdict rests on — every field readable on a device. */
export interface Chaos07Obs {
  readonly deviceCount: number;
  /** Foreign ops the pull phase applied across all devices (member edits + system ops). 0 ⇒ the pull path
   *  never moved anything and convergence/winner are vacuous ⇒ INCONCLUSIVE (§2.11). */
  readonly foreignApplied: number;
  /** Devices whose full notes digest equals device A's — must equal `deviceCount` (all converged). */
  readonly converged: number;
  /** The LWW winner body computed by the INDEPENDENT `(timestamp,deviceId,seq)` sort over note-1's edits
   *  (reversed by the `reverseWinnerOracle` control). */
  readonly winnerBodyExpected: string;
  /** The note-1 body every converged device actually holds (read off device A's projection). */
  readonly winnerBodyConverged: string;
  /** note-1 edits seen across the run — the winner-check denominator (0 ⇒ no LWW race to judge). */
  readonly note1Edits: number;
  // ── leg 2 (edit-after-archive) ──
  /** The SIGNIFICANT `platform.conflict_detected` op FOR NOTE-2 landed in B's own op log via the pull path
   *  (verified, not quarantined) — scoped to note-2 + significant so leg 1's own note-1 MINOR conflict ops
   *  cannot forge the witness (`detectedEditAfterArchive`). false ⇒ nothing to witness for (iii) ⇒
   *  INCONCLUSIVE ("never surfaced"). */
  readonly iiiDetectedApplied: boolean;
  /** Significant conflicts on note-2 resting `surfaced` in B's OWN conflicts projection — the
   *  client-observable surfacing (§3.6). */
  readonly iiiSurfacedOnDevice: number;
  /** note-2 stays archived on both A and B after convergence (the edit never un-archives it, 03 §11). */
  readonly iiiArchivedHeld: boolean;
  /** note-2's converged body (device A) vs the edit that must stand (device B's) — the edit survives. */
  readonly iiiBodyConverged: string;
  readonly iiiBodyExpected: string;
}

export interface Chaos07Result {
  readonly obs: Chaos07Obs;
  close(): Promise<void>;
}

/** A per-device authoring PRNG offset (unused for values here — bodies are seed-derived — but keeps each
 *  device's id source distinct, mirroring chaos03/06). */
function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e37_79b1) ^ Math.imul(index + 1, 0x85eb_ca77)) >>> 0;
}

/** A per-seed-unique body (T-3): a body that survived to a projection NAMES which op won. */
function body(seed: number, device: string, n: number): string {
  return `body-${seed}-${device}-${n}`;
}

/** Canonical order (05 §4): timestamp ASC, then deviceId ASC (UTF-16 code-unit), then seq ASC. */
function canonicalCompare(a: SignedOperation, b: SignedOperation): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return a.seq - b.seq;
}

/** Union ops across devices, deduped by id (after convergence every device holds all of them). */
function dedupById(groups: readonly SignedOperation[][]): SignedOperation[] {
  const byId = new Map<string, SignedOperation>();
  for (const group of groups) for (const op of group) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}

/** A device's OWN create op for a note (wire shape), to propagate to the editors that did not create it
 *  (the `editNote` precondition needs the note held locally, commands.ts). */
async function findCreateOp(device: VirtualDevice, noteId: string): Promise<SignedOperation> {
  const op = (await device.wireOps()).find((w) => w.type === NOTE_CREATED && w.entityId === noteId);
  if (op === undefined)
    throw new Error(`create op for ${noteId} not found on ${device.identity.deviceId}`);
  return op;
}

/** Significant conflicts on `noteId` resting `surfaced` in a device's OWN conflicts projection (03 §7).
 *  The client DB is SQLite (op-sqlite on device, better-sqlite3 on the host proof) — no Postgres `::int`
 *  cast (`notesRows` avoids casts for the same reason); `COUNT(*)` is wrapped in `Number` for both drivers. */
async function surfacedConflicts(device: VirtualDevice, noteId: string): Promise<number> {
  const r = await sql<{ n: number | bigint }>`
    SELECT COUNT(*) AS n FROM conflicts
    WHERE entity_id = ${noteId} AND severity = 'significant' AND status = 'surfaced'
  `.execute(device.db);
  return Number(r.rows[0]?.n ?? 0);
}

/** The note's row in a device's projection (or undefined if absent). */
async function noteRow(device: VirtualDevice, noteId: string): Promise<NotesRow | undefined> {
  return (await notesRows(device.db)).find((row) => row.id === noteId);
}

/**
 * Did device B pull + fold the SIGNIFICANT edit-after-archive `platform.conflict_detected` op for `noteId`
 * (leg 2's non-vacuity witness)?
 *
 * Scoped to `noteId` + `significant` ON PURPOSE. Leg 1's concurrent same-note edits also make the server
 * mint `conflict_detected` ops — MINOR `{note.body}` ones for note-1 (conflict-detection.ts emits one op
 * per detected pair, minor included) — which B pull-drains too. An UNSCOPED `some(type === conflictDetected)`
 * would therefore read `true` from note-1's minor ops ALONE, defeating the "(iii) never surfaced ⇒
 * INCONCLUSIVE" guard: a server-side leg-2 regression (note-2's op never delivered) would surface as a RED
 * that falsely blames the client classification fold instead of the honest INCONCLUSIVE. The op's top-level
 * `entityId` is a NEW conflict id, so the conflicted note id + its static severity are read off the payload
 * (01 §6). `chaos07.test.ts` watches the unscoped form go red. */
export function detectedEditAfterArchive(
  wire: readonly SignedOperation[],
  noteId: string,
): boolean {
  return wire.some((o) => {
    if (o.type !== PLATFORM_OP.conflictDetected) return false;
    const p = o.payload as { entityId?: string; severity?: string } | undefined;
    return p?.entityId === noteId && p?.severity === 'significant';
  });
}

/**
 * Drive the CHAOS-07 workload over the injected server seam and return every client-side observation the
 * verdict rests on. Structure:
 *   authoring — A creates note-1 + note-2; the creates are propagated to the editors (so their local
 *               precondition passes), EXCEPT the archive, which B must never see (that is the whole point
 *               of (iii)). A/B/C edit note-1 at strictly increasing timestamps (C last ⇒ C wins); A
 *               archives note-2; B edits note-2 at a timestamp AFTER the archive (causal, so Rule 2 fires).
 *   push      — A, then B, then C, each its own local ops. Order is causal for (iii): A's archive must be
 *               in the server log before B's edit is accepted (conflict-detection.ts `existsPrecedingOp`).
 *   pull      — each device pull-drains everything (store-wide scope). The server-minted
 *               `platform.conflict_detected` op is pulled + verified + folded like any other op; whether
 *               it actually reached B (`iiiDetectedApplied`, read off B's own op log) is the (iii)
 *               non-vacuity witness — false ⇒ INCONCLUSIVE, never a silent green (§2.11).
 */
export async function runChaos07(
  seed: number,
  options: Chaos07Options,
  seams: ConvergenceSeams,
  net: Chaos07Net,
): Promise<Chaos07Result> {
  const pushBatch = options.pushBatch ?? DEFAULT_PUSH_BATCH;
  const pullLimit = options.pullLimit ?? DEFAULT_PULL_LIMIT;
  if (net.auth.length !== CHAOS07_DEVICE_COUNT) {
    throw new Error(
      `CHAOS-07 net handoff has ${net.auth.length} bearers but the run needs ${CHAOS07_DEVICE_COUNT} ` +
        `(A/B/C edit the shared note; A archives + B edits the second note)`,
    );
  }

  const ids = mintIdentities(seed, CHAOS07_DEVICE_COUNT);
  const devices = await Promise.all(
    ids.devices.map((identity, i) =>
      VirtualDevice.open(
        {
          identity,
          clock: new FakeClock(CLOCK_BASE + i),
          prng: mulberry32(deviceSeed(seed, i)),
          extraModules: [platformExtra],
        },
        seams,
      ),
    ),
  );
  const [deviceA, deviceB, deviceC] = devices as [VirtualDevice, VirtualDevice, VirtualDevice];
  const transports = devices.map((_, i) => new HttpTransport(net.fetch, net.auth[i]!));

  try {
    const base = CLOCK_BASE + 1_000_000;

    // ── authoring ──────────────────────────────────────────────────────────────────────────────────
    deviceA.clock.set(base);
    const note1 = await deviceA.createNote({ title: `n1-${seed}`, body: body(seed, 'A', 0) });
    deviceA.clock.set(base + 100);
    const note2 = await deviceA.createNote({ title: `n2-${seed}`, body: body(seed, 'A', 2) });

    // Propagate the creates so the editors hold the notes locally. The ARCHIVE is NOT propagated — B must
    // be offline through it for Rule 2 to fire only server-side.
    const createNote1 = await findCreateOp(deviceA, note1);
    const createNote2 = await findCreateOp(deviceA, note2);
    await deviceB.applyForeign(createNote1);
    await deviceC.applyForeign(createNote1);
    await deviceB.applyForeign(createNote2);

    deviceA.clock.set(base + 1_000);
    await deviceA.editNote(note1, body(seed, 'A', 1));
    deviceA.clock.set(base + 1_500);
    await deviceA.archiveNote(note2);

    deviceB.clock.set(base + 2_000);
    await deviceB.editNote(note1, body(seed, 'B', 1));
    deviceB.clock.set(base + 2_500);
    const iiiBodyExpected = body(seed, 'B', 2);
    await deviceB.editNote(note2, iiiBodyExpected); // AFTER the archive ⇒ Rule 2 fires at the server

    deviceC.clock.set(base + 3_000);
    await deviceC.editNote(note1, body(seed, 'C', 1)); // canonically last ⇒ the LWW winner

    // ── push (causal for (iii): A's archive lands before B's edit is judged) ──────────────────────────
    for (const [i, device] of devices.entries()) {
      await pushDevice(device, transports[i]!, { batchSize: pushBatch });
    }

    // ── pull-drain (each device drains the store-wide op stream, incl. the system detection op) ─────────
    const pullA = await pullDevice(deviceA, transports[0]!, { limit: pullLimit });
    const pullB = await pullDevice(deviceB, transports[1]!, { limit: pullLimit });
    const pullC = await pullDevice(deviceC, transports[2]!, { limit: pullLimit });
    const foreignApplied = pullA.applied + pullB.applied + pullC.applied;

    // ── leg 1 observations: convergence + LWW winner ──────────────────────────────────────────────────
    const digestA = await deviceA.digest();
    const digests = await Promise.all(devices.map((d) => d.digest()));
    const converged = digests.filter((d) => d === digestA).length;

    const allOps = dedupById(await Promise.all(devices.map((d) => d.wireOps())));
    const note1Edits = allOps
      .filter((o) => o.type === NOTE_EDITED && o.entityId === note1)
      .sort(canonicalCompare);
    const winnerOp =
      options.reverseWinnerOracle === true ? note1Edits[0] : note1Edits[note1Edits.length - 1];
    const winnerBodyExpected =
      (winnerOp?.payload as { body?: string } | undefined)?.body ?? '(none)';
    const winnerBodyConverged = (await noteRow(deviceA, note1))?.body ?? '(absent)';

    // ── leg 2 observations: edit-after-archive surfaced on the device ─────────────────────────────────
    const bWire = await deviceB.wireOps();
    const iiiDetectedApplied = detectedEditAfterArchive(bWire, note2);
    const iiiSurfacedOnDevice = await surfacedConflicts(deviceB, note2);
    const aNote2 = await noteRow(deviceA, note2);
    const bNote2 = await noteRow(deviceB, note2);
    const iiiArchivedHeld = aNote2?.archived === 1 && bNote2?.archived === 1;
    const iiiBodyConverged = aNote2?.body ?? '(absent)';

    return {
      obs: {
        deviceCount: CHAOS07_DEVICE_COUNT,
        foreignApplied,
        converged,
        winnerBodyExpected,
        winnerBodyConverged,
        note1Edits: note1Edits.length,
        iiiDetectedApplied,
        iiiSurfacedOnDevice,
        iiiArchivedHeld,
        iiiBodyConverged,
        iiiBodyExpected,
      },
      close: async () => {
        for (const d of devices) await d.close();
      },
    };
  } catch (error) {
    for (const d of devices) await d.close();
    throw error;
  }
}

/** The single verdict both bindings share. INCONCLUSIVE (a dead pull path, or (iii) never surfaced) and a
 *  RED (divergence, a wrong LWW winner, a detected-but-not-surfaced fold, or a lost/un-archived edit) are
 *  BOTH `ok: false` — never pass on an inconclusive run (§2.11 / task 198 Acceptance). */
export interface Chaos07Verdict {
  readonly ok: boolean;
  readonly inconclusive: boolean;
  readonly reason: string;
  readonly metrics: {
    readonly deviceCount: number;
    readonly converged: number;
    readonly foreignApplied: number;
    readonly surfacedOnDevice: number;
  };
}

export function evaluateChaos07(result: Chaos07Result): Chaos07Verdict {
  const o = result.obs;
  const metrics = {
    deviceCount: o.deviceCount,
    converged: o.converged,
    foreignApplied: o.foreignApplied,
    surfacedOnDevice: o.iiiSurfacedOnDevice,
  } as const;
  const fail = (reason: string, inconclusive = false): Chaos07Verdict => ({
    ok: false,
    inconclusive,
    reason,
    metrics,
  });

  // INCONCLUSIVE (dead pull path) FIRST — if no foreign op ever applied, convergence + winner are vacuous.
  if (o.foreignApplied <= 0) {
    return fail(
      `INCONCLUSIVE: the pull phase applied ${o.foreignApplied} foreign ops — nothing crossed the wire, ` +
        `so convergence and the LWW winner prove nothing (§2.11).`,
      true,
    );
  }
  if (o.note1Edits <= 0) {
    return fail(
      `INCONCLUSIVE: no note-1 edits were seen — there was no LWW race to judge (§2.11).`,
      true,
    );
  }

  // RED — divergence: some device folded the shared note to a different projection than device A.
  if (o.converged !== o.deviceCount) {
    return fail(
      `only ${o.converged}/${o.deviceCount} devices converged on device A's notes digest — the shared ` +
        `note did not merge to one projection (§3.6).`,
    );
  }

  // RED — converged but WRONG winner: the surviving body is not the canonical `(timestamp,deviceId,seq)`
  // last edit. Judged against the INDEPENDENT oracle sort, so a fold that drifts from 05 §4 is caught.
  if (o.winnerBodyConverged !== o.winnerBodyExpected) {
    return fail(
      `the devices converged but on the WRONG LWW winner: projection holds "${o.winnerBodyConverged}", ` +
        `canonical (timestamp,deviceId,seq) last edit is "${o.winnerBodyExpected}" (05 §4).`,
    );
  }

  // INCONCLUSIVE ((iii) never surfaced) — no `platform.conflict_detected` op reached B, so there is no
  // edit-after-archive conflict to witness (detection off, or the system op never delivered). Never green.
  if (!o.iiiDetectedApplied) {
    return fail(
      `INCONCLUSIVE: no platform.conflict_detected op reached device B — edit-after-archive never ` +
        `surfaced, so (iii) proves nothing (§2.11 / task 198).`,
      true,
    );
  }

  // RED — detected but NOT surfaced: B folded the detection op yet its conflicts projection shows no
  // significant `surfaced` conflict on note-2 — a broken client classification fold (03 §7).
  if (o.iiiSurfacedOnDevice !== 1) {
    return fail(
      `device B folded a conflict_detected op but its conflicts projection shows ${o.iiiSurfacedOnDevice} ` +
        `significant \`surfaced\` conflicts on note-2 (expected exactly 1) — the client classification fold ` +
        `is wrong (03 §7).`,
    );
  }

  // RED — the edit-after-archive outcome (03 §11's total rule): the edit must stand AND the note stay
  // archived; the archive is terminal and the edit never un-archives it.
  if (!o.iiiArchivedHeld) {
    return fail(`note-2 is not archived on both A and B — the archive did not hold (03 §11).`);
  }
  if (o.iiiBodyConverged !== o.iiiBodyExpected) {
    return fail(
      `note-2's converged body is "${o.iiiBodyConverged}" but device B's edit "${o.iiiBodyExpected}" must ` +
        `stand (the edit-after-archive edit is not lost, 03 §11).`,
    );
  }

  return {
    ok: true,
    inconclusive: false,
    reason:
      `${o.converged}/${o.deviceCount} devices converged on the shared note; the LWW winner "${o.winnerBodyConverged}" ` +
      `is the canonical (timestamp,deviceId,seq) last edit; and edit-after-archive surfaced a significant ` +
      `conflict on device B (note stays archived, the edit stands) — concurrent-edit resolution is correct (§3.6).`,
    metrics,
  };
}
