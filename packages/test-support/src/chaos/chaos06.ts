// CHAOS-06 replay / idempotency, over the SERVER round trip (testing-guide §3.6, 05 §5) — the shared,
// platform-free body the on-device runner and the host watched-RED test both drive (task 198). Where
// CHAOS-03 asks "do days-offline authors converge?", CHAOS-06 asks the dual: "does re-delivering ops
// the server already holds change anything?" The answer must be NO — the server dedups by op id
// (05 §5), so a replayed batch comes back `duplicate`, the client fold is untouched, and re-pulling
// held ops applies zero. A replay that RE-INSERTS (an `edit_count` doubles, a held op re-applies) is
// the bug this catches.
//
// ── ONE RIG, TWO BINDINGS (§2.8), extended to the server seam ─────────────────────────────────────
// Same shape as chaos03.ts: the SERVER is injected as `Chaos06Net` (a `FetchLike` + one bearer per
// device, in `mintIdentities` order). On the host test that fetch is `socketBaseFetch(startHarnessServer().url)`
// (a real loopback socket to the in-process `@bolusi/server`); on device it is the RN global `fetch`
// over `10.0.2.2` / `adb reverse` (§2.6). Neither this file nor the bindings re-implement the fold,
// the transport, or the verdict (T-7): push is the production `HttpTransport.push` (read directly, so
// the per-op `status` is visible and the device's locals stay `local` for the replay), pull is the
// production `pullDevice` (pull-until-drained, atomic apply, cursor advance).
//
// ── EVERY ASSERTION IS CLIENT-OBSERVABLE ──────────────────────────────────────────────────────────
// A device cannot read `server.db` (the Node scenario's `serverSeqById` — the server op count + seq).
// So the §3.6 idempotency properties are witnessed only through client-side signal:
//   DEDUP-ON-WIRE — the replayed ops come back `duplicate`, not `accepted`, in `PushResponse.results`
//                   (the ONE server-side fact that reaches the client). A first delivery that was NOT
//                   all-`accepted` means the premise never held, so a later accept cannot be read as a
//                   re-insert — that run is INCONCLUSIVE, never a pass (§2.11 / task 198 Acceptance).
//   FOLD-STABLE   — the notes digest + summed `edit_count` do not move across the replay and a
//                   held-op pull; a double-applied duplicate would move them.
//   HELD-PULL     — re-pulling ops the device already authored applies 0 (dedup by id on the pull path).
//                   Non-vacuous BY CONSTRUCTION: the server's pull scope is store-wide with NO
//                   own-device exclusion (apps/server sync/pull.ts), so device A's own ops ARE re-served;
//                   a `CountingTransport` witnesses that the held pull RECEIVED ops over the wire, so
//                   applied 0 means "received and deduped", never "received nothing" (§2.11). Received 0
//                   ⇒ INCONCLUSIVE.
//   POSITIVE CTRL — a NOVEL foreign op (device B's) still applies over the wire and DOES move
//                   `edit_count`; without it, "applied 0 / digest stable" could be a dead pull path,
//                   not idempotency (§2.11) — so a dead control is INCONCLUSIVE.
// `evaluateChaos06` turns those observations into ONE verdict both bindings share — a green on device
// means exactly what a green in the host test means.
//
// PLATFORM/DOMAIN-FREE (task 181): reaches no `node:` builtin — `noblePort` arrives through the sibling
// transport.js, the determinism leaves through `../determinism/*`. `chaos-bundle-safe.test.ts` guards it.
import type { PushResult } from '@bolusi/schemas';

import { FakeClock } from '../determinism/clock.js';
import { mulberry32, randomInt, type Prng } from '../determinism/prng.js';

import { VirtualDevice } from './device.js';
import { mintIdentities } from './identities.js';
import { notesRows, type NotesRow } from './oracle.js';
import type { ConvergenceSeams } from './seams.js';
import {
  CountingTransport,
  HttpTransport,
  pullDevice,
  pushDevice,
  type FetchLike,
} from './transport.js';

const CLOCK_BASE = 1_726_100_000_000;
const DEFAULT_PUSH_BATCH = 60; // well under the api/01 §3 cap of 500; sized so a device run spans ≥2 batches.
const DEFAULT_PULL_LIMIT = 500;

/** The two roles this rig needs: device A replays its own history; device B authors the NOVEL foreign
 *  op that is the positive control (a note A has never seen, so A's pull must apply it). Fixed at 2 —
 *  the property does not scale with device count the way CHAOS-03's merge does. */
export const CHAOS06_DEVICE_COUNT = 2;

/** The options the on-device runner and the host test share — a DEVICE-appropriate reduction of the
 *  §3.6 volume, sized so device A's history spans several push batches (so the replay re-sends a real
 *  batch, not a single op) while a low-end Android still finishes within the harness budget. */
export interface Chaos06Options {
  /** Notes device A creates (each an entity the edits below re-fold). */
  readonly creates: number;
  /** Edits device A makes across those notes — the `edit_count` a re-insert would double. */
  readonly edits: number;
  readonly pushBatch?: number;
  readonly pullLimit?: number;
  /** How many TRAILING push batches to replay verbatim (default 2). */
  readonly replayBatches?: number;
  /** Negative control (WATCHED RED): rewrite each replayed op's `duplicate` result to `accepted`,
   *  simulating a server that re-inserts instead of deduping by id — the response-side fault the
   *  DEDUP-ON-WIRE assertion must catch, exactly as CHAOS-03's `DroppingPullTransport` rewrites a pull
   *  response. `evaluateChaos06` must then return a RED (a replay accepted = a re-insert). */
  readonly reinsertOnReplay?: boolean;
  /** INCONCLUSIVE inducer (control): skip the first delivery, so the "replay" pushes are first-seen
   *  `accepted`. With no clean prior delivery the premise never holds, and a later accept cannot be
   *  read as a re-insert — the verdict must be INCONCLUSIVE, never RED. */
  readonly skipFirstDelivery?: boolean;
}

export const DEFAULT_CHAOS06_OPTIONS: Chaos06Options = {
  creates: 20,
  edits: 100,
  pushBatch: DEFAULT_PUSH_BATCH,
  replayBatches: 2,
};

/** A fixed seed so the on-device run is deterministic and reproducible (the PRNG is fully seeded). */
export const DEFAULT_CHAOS06_SEED = 206;

/** The server seam: a `fetch` to the host `@bolusi/server` + one bearer per device, in `mintIdentities`
 *  order (index `i` ↔ device `i`). The host driver seeds those keys out-of-band and hands these back. */
export interface Chaos06Net {
  readonly fetch: FetchLike;
  readonly auth: readonly string[];
}

/** The client-side observations the verdict rests on — every field is readable on a device. */
export interface Chaos06Obs {
  /** Ops device A pushed on its FIRST delivery (its own locals: genesis + authored notes). 0 when the
   *  `skipFirstDelivery` control is on. */
  readonly firstDeliveryOps: number;
  /** Of those, how many the server returned `accepted` — must equal `firstDeliveryOps` for the premise
   *  (a clean first-seen delivery) to hold. */
  readonly firstDeliveryAccepted: number;
  /** Ops device A RE-pushed verbatim (the trailing batches). */
  readonly replayOps: number;
  /** Of the replay, how many came back `duplicate` — the DEDUP-ON-WIRE witness. */
  readonly replayDuplicate: number;
  /** Ops the held-op pull RECEIVED over the wire (the `CountingTransport` witness). > 0 or the held pull
   *  delivered nothing to dedup and `heldPullApplied === 0` is vacuous ⇒ INCONCLUSIVE (§2.11). */
  readonly heldPullReceived: number;
  /** Ops a held-op pull applied — must be 0 (device A re-pulling its own already-held ops). */
  readonly heldPullApplied: number;
  /** Ops device A's pull applied for device B's NOVEL note — the positive control (> 0 or the pull
   *  path is inert and the held-pull 0 proves nothing). */
  readonly novelPullApplied: number;
  readonly digestAfterDelivery: string;
  readonly digestAfterHeldPull: string;
  readonly editsAfterDelivery: number;
  readonly editsAfterHeldPull: number;
  readonly editsAfterNovelPull: number;
}

export interface Chaos06Result {
  readonly obs: Chaos06Obs;
  close(): Promise<void>;
}

/** A per-device authoring PRNG, distinct per (run seed, device index). Mirrors chaos03.ts. */
function deviceSeed(seed: number, index: number): number {
  return (Math.imul(seed + 1, 0x9e37_79b1) ^ Math.imul(index + 1, 0x85eb_ca77)) >>> 0;
}

/** Split `ops` into ≤`size` slices, order-preserving (push batches ascend by per-device seq). */
function chunk<T>(ops: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

/** Sum `edit_count` across the notes projection — the scalar a double-applied edit would inflate. */
function sumEdits(rows: readonly NotesRow[]): number {
  return rows.reduce((total, row) => total + row.editCount, 0);
}

/** Tally a push response's per-op statuses (the ONLY server-side fact that reaches a device). */
function tally(results: readonly PushResult[]): { accepted: number; duplicate: number } {
  let accepted = 0;
  let duplicate = 0;
  for (const result of results) {
    if (result.status === 'accepted') accepted += 1;
    else if (result.status === 'duplicate') duplicate += 1;
  }
  return { accepted, duplicate };
}

/**
 * Author `creates` notes then `edits` edits across them on `device`, advancing the FakeClock per op so
 * the history has a real ordering. The edits are what a replay could double-count, so this is the
 * workload CHAOS-06 replays — not the cross-device edit weighting CHAOS-03 uses.
 */
async function authorHistory(
  device: VirtualDevice,
  prngSeed: number,
  creates: number,
  edits: number,
): Promise<void> {
  const prng: Prng = mulberry32(prngSeed ^ 0x0606_0606);
  const short = device.identity.deviceId.slice(0, 6);
  const noteIds: string[] = [];
  for (let n = 0; n < creates; n += 1) {
    device.clock.advance(randomInt(prng, 1, 1_000));
    noteIds.push(await device.createNote({ title: `n-${short}-${n}`, body: `b-${short}-${n}` }));
  }
  for (let e = 0; e < edits; e += 1) {
    device.clock.advance(randomInt(prng, 1, 1_000));
    const target = noteIds[randomInt(prng, 0, noteIds.length - 1)]!;
    await device.editNote(target, `edit-${short}-${e}`);
  }
}

/**
 * Run the CHAOS-06 replay/idempotency workload over the injected server seam and return every
 * client-side observation the verdict rests on. Structure:
 *   phase 1 — FIRST DELIVERY: device A authors ~(creates+edits) ops, pushed in batches through the real
 *             `HttpTransport.push` (NOT `pushDevice`, so its locals stay `local` and the exact bytes can
 *             be re-sent). Every op must come back `accepted` — the premise the replay rests on.
 *   phase 2 — REPLAY: re-push the trailing `replayBatches` batches verbatim. Every op must come back
 *             `duplicate` (the server dedups by id, 05 §5). The `reinsertOnReplay` control rewrites
 *             those to `accepted` to prove the assertion is load-bearing.
 *   phase 3 — HELD PULL: device A pulls — its own ops are already held, so the pull applies 0 and the
 *             digest + `edit_count` do not move.
 *   phase 4 — POSITIVE CONTROL: device B authors + pushes a NOVEL note (+ an edit); device A pulls
 *             again and MUST apply it and move `edit_count` — proving the held-pull 0 was dedup, not a
 *             dead pull path.
 */
export async function runChaos06(
  seed: number,
  options: Chaos06Options,
  seams: ConvergenceSeams,
  net: Chaos06Net,
): Promise<Chaos06Result> {
  const pushBatch = options.pushBatch ?? DEFAULT_PUSH_BATCH;
  const pullLimit = options.pullLimit ?? DEFAULT_PULL_LIMIT;
  const replayBatches = options.replayBatches ?? 2;
  if (net.auth.length !== CHAOS06_DEVICE_COUNT) {
    throw new Error(
      `CHAOS-06 net handoff has ${net.auth.length} bearers but the run needs ${CHAOS06_DEVICE_COUNT} ` +
        `(device A replays, device B authors the novel positive-control op)`,
    );
  }

  const ids = mintIdentities(seed, CHAOS06_DEVICE_COUNT);
  const deviceA = await VirtualDevice.open(
    {
      identity: ids.devices[0]!,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(deviceSeed(seed, 0)),
    },
    seams,
  );
  const deviceB = await VirtualDevice.open(
    {
      identity: ids.devices[1]!,
      clock: new FakeClock(CLOCK_BASE + 1),
      prng: mulberry32(deviceSeed(seed, 1)),
    },
    seams,
  );
  const transportA = new HttpTransport(net.fetch, net.auth[0]!);
  const transportB = new HttpTransport(net.fetch, net.auth[1]!);

  try {
    await authorHistory(deviceA, deviceSeed(seed, 0), options.creates, options.edits);
    const ops = await deviceA.wireOps();
    const batches = chunk(ops, pushBatch);

    // Phase 1 — first delivery. Skipped by the INCONCLUSIVE control, which leaves firstDeliveryOps 0.
    let firstDeliveryOps = 0;
    let firstDeliveryAccepted = 0;
    if (options.skipFirstDelivery !== true) {
      for (const batch of batches) {
        const response = await transportA.push({ deviceId: deviceA.identity.deviceId, ops: batch });
        const counts = tally(response.results);
        firstDeliveryOps += batch.length;
        firstDeliveryAccepted += counts.accepted;
      }
    }
    const digestAfterDelivery = await deviceA.digest();
    const editsAfterDelivery = sumEdits(await notesRows(deviceA.db));

    // Phase 2 — replay the trailing batches verbatim (device A's locals are still `local`).
    const replay = batches.slice(-replayBatches);
    let replayOps = 0;
    let replayDuplicate = 0;
    for (const batch of replay) {
      const response = await transportA.push({ deviceId: deviceA.identity.deviceId, ops: batch });
      // The re-insert control rewrites the server's `duplicate` to `accepted` — a non-deduping server,
      // observed client-side. Off, the real statuses pass through unchanged.
      const results =
        options.reinsertOnReplay === true
          ? response.results.map((result) =>
              result.status === 'duplicate' ? { ...result, status: 'accepted' as const } : result,
            )
          : response.results;
      replayOps += batch.length;
      replayDuplicate += tally(results).duplicate;
    }

    // Phase 3 — held pull: device A re-pulls its OWN ops (the server's store-wide pull scope re-serves
    // them — apps/server sync/pull.ts has NO own-device exclusion) THROUGH a counting transport, so we
    // witness that the pull RECEIVED ops over the wire. Dedup by id ⇒ applied 0 with the fold unchanged;
    // received 0 would make that 0 vacuous (§2.11), so `heldPullReceived` guards it.
    const heldCounter = new CountingTransport(transportA);
    const heldPull = await pullDevice(deviceA, heldCounter, { limit: pullLimit });
    const heldPullReceived = heldCounter.pulledSinceReset();
    const digestAfterHeldPull = await deviceA.digest();
    const editsAfterHeldPull = sumEdits(await notesRows(deviceA.db));

    // Phase 4 — positive control: device B authors + pushes a NOVEL note; device A pulls and MUST apply.
    const novelId = await deviceB.createNote({
      title: `novel-${seed}`,
      body: `novel-${seed}`,
    });
    await deviceB.editNote(novelId, `novel-edit-${seed}`);
    await pushDevice(deviceB, transportB, { batchSize: pushBatch });
    const novelPull = await pullDevice(deviceA, transportA, { limit: pullLimit });
    const editsAfterNovelPull = sumEdits(await notesRows(deviceA.db));

    return {
      obs: {
        firstDeliveryOps,
        firstDeliveryAccepted,
        replayOps,
        replayDuplicate,
        heldPullReceived,
        heldPullApplied: heldPull.applied,
        novelPullApplied: novelPull.applied,
        digestAfterDelivery,
        digestAfterHeldPull,
        editsAfterDelivery,
        editsAfterHeldPull,
        editsAfterNovelPull,
      },
      close: async () => {
        await deviceA.close();
        await deviceB.close();
      },
    };
  } catch (error) {
    // A throw before the observations exist must not leak the two device DBs.
    await deviceA.close();
    await deviceB.close();
    throw error;
  }
}

/** The single verdict both bindings share. INCONCLUSIVE (the premise/positive-control never held) and a
 *  RED (a replay re-inserted, or a held op re-applied) are BOTH `ok: false` — never pass on an
 *  inconclusive run (§2.11 / task 198 Acceptance). */
export interface Chaos06Verdict {
  readonly ok: boolean;
  readonly inconclusive: boolean;
  readonly reason: string;
  readonly metrics: {
    readonly replayed: number;
    readonly duplicate: number;
    readonly heldPullApplied: number;
    readonly novelPullApplied: number;
  };
}

export function evaluateChaos06(result: Chaos06Result): Chaos06Verdict {
  const o = result.obs;
  const metrics = {
    replayed: o.replayOps,
    duplicate: o.replayDuplicate,
    heldPullApplied: o.heldPullApplied,
    novelPullApplied: o.novelPullApplied,
  } as const;
  const fail = (reason: string, inconclusive = false): Chaos06Verdict => ({
    ok: false,
    inconclusive,
    reason,
    metrics,
  });

  // INCONCLUSIVE (premise) FIRST — before any re-insert claim. Without a clean first-seen delivery, a
  // later `accepted` on replay is just a first delivery, not a re-insert. `skipFirstDelivery` lands here.
  if (o.firstDeliveryOps <= 0) {
    return fail(
      `INCONCLUSIVE: no first delivery ran, so the server never returned a \`duplicate\` and a replay ` +
        `\`accepted\` cannot be read as a re-insert — nothing to witness (§2.11).`,
      true,
    );
  }
  if (o.firstDeliveryAccepted !== o.firstDeliveryOps) {
    return fail(
      `INCONCLUSIVE: only ${o.firstDeliveryAccepted}/${o.firstDeliveryOps} ops landed \`accepted\` on ` +
        `first delivery — the chain never cleanly first-seen, so a later \`accepted\` is not a re-insert (§2.11).`,
      true,
    );
  }
  if (o.replayOps <= 0) {
    return fail(
      `INCONCLUSIVE: nothing was replayed — no \`duplicate\` signal to witness (§2.11).`,
      true,
    );
  }

  // RED — the wire re-insert: a replayed op the server should have deduped came back NOT `duplicate`.
  // Independent of the pull path, so it is judged before the positive control.
  const replayNonDuplicate = o.replayOps - o.replayDuplicate;
  if (replayNonDuplicate > 0) {
    return fail(
      `${replayNonDuplicate}/${o.replayOps} replayed ops came back NOT \`duplicate\` — the server ` +
        `re-inserted ops it already held instead of deduping by id (05 §5).`,
    );
  }

  // INCONCLUSIVE (positive control) — the held-pull 0 and the stable fold below prove idempotency ONLY
  // if the pull path can actually apply a foreign op and move `edit_count`. A dead control makes them
  // vacuous, so it is inconclusive, never green (§2.11).
  if (o.novelPullApplied <= 0 || o.editsAfterNovelPull <= o.editsAfterHeldPull) {
    return fail(
      `INCONCLUSIVE: the novel foreign op applied ${o.novelPullApplied} and moved edit_count ` +
        `${o.editsAfterHeldPull}→${o.editsAfterNovelPull} — the pull path is inert, so the held-pull ` +
        `applied=${o.heldPullApplied} reading proves nothing (§2.11).`,
      true,
    );
  }

  // INCONCLUSIVE (non-vacuity) — the held-pull `applied === 0` only witnesses dedup if the pull actually
  // RECEIVED ops to dedup. If the server re-served nothing (received 0), applied 0 is trivially true and
  // proves no idempotency — so it is inconclusive, never green (§2.11).
  if (o.heldPullReceived <= 0) {
    return fail(
      `INCONCLUSIVE: the held-op pull received ${o.heldPullReceived} ops over the wire — with nothing ` +
        `re-served there was nothing to dedup, so applied=${o.heldPullApplied} proves nothing (§2.11).`,
      true,
    );
  }

  // RED — dedup failed on the PULL path: device A re-applied ops it already authored.
  if (o.heldPullApplied !== 0) {
    return fail(
      `the held-op pull applied ${o.heldPullApplied} ops device A already held — dedup by id failed on ` +
        `the pull path (05 §5).`,
    );
  }

  // RED — a duplicate was DOUBLE-APPLIED into the projection (an `edit_count` doubled), the sharpest
  // idempotency failure. Checked against BOTH the digest and the summed edit_count.
  if (
    o.digestAfterHeldPull !== o.digestAfterDelivery ||
    o.editsAfterHeldPull !== o.editsAfterDelivery
  ) {
    return fail(
      `the notes projection moved across the replay + held pull (edit_count ${o.editsAfterDelivery}` +
        `→${o.editsAfterHeldPull}) — a duplicate was double-applied (§3.6).`,
    );
  }

  return {
    ok: true,
    inconclusive: false,
    reason:
      `device A delivered ${o.firstDeliveryOps} ops (all accepted), replayed ${o.replayOps} verbatim ` +
      `(all duplicate), a held-op pull applied 0 with digest + edit_count unchanged, and a novel foreign ` +
      `op still applied (edit_count ${o.editsAfterHeldPull}→${o.editsAfterNovelPull}) — replay is idempotent (§3.6).`,
    metrics,
  };
}
