// CHAOS-08 — projection rebuild mid-stream (testing-guide §3.6 / 04 §4.3, FR-1116).
//
// A device with a large op history rebuilds its projection from the log; a control device holding the
// identical op set never rebuilds. PASS (§3.6): post-rebuild digest == control's incremental digest ==
// canonical fold (including the mid-stream ops); rebuild RESUMABILITY is proven by watermark
// monotonicity — a rebuild killed at 25/50/75% and resumed never re-applies below the checkpoint, so
// every op is folded EXACTLY ONCE (the engine's `rebuildApplies` counter, summed across resumes, equals
// the history size — no more).
//
// The rebuild is the REAL engine's `runRebuild` (04 §4.3), driven through `device.rebuild` — never
// re-implemented (T-7). `stopAfterBatches` models a process kill at a batch boundary; the durable
// `rebuild_cursor` (meta_kv) is what a fresh call resumes from.
//
// SCALE (heavy scenario — testing-guide §3.7 D-CHAOS-SCALE): FULL 20,000 + 500 volume in the merge
// gate, but the SEED SWEEP is bounded to the first CI seed (`chaos08Seeds`); the nightly and any
// explicit `CHAOS_SEEDS=` run every seed. The volume is NEVER cut — the seed sweep is the knob. A
// 20,000-op rebuild is ~54 s and vitest runs a file's tests SERIALLY, so the old seeds-1–10 sweep
// serialized this one file to ~9 min and was the gate's long pole.
//
// Falsification (§2.11): the watermark guard is load-bearing precisely because a rebuild that DID
// re-apply below the checkpoint would double-count `edit_count` and inflate `rebuildApplies` past the
// history size. The control below watches that go RED — forcing a fresh restart on resume (clearing the
// cursor) folds the whole history TWICE, and both the digest-vs-control and the exact-count assertions
// fail.
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32, type Prng } from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { mintIdentities } from '../src/identities.js';
import { canonicalFold, assertConvergence, notesRows } from '../src/oracle.js';
import { activeVolumes, insertPulledOp, resolveSeeds, withSeed } from '../src/index.js';

/**
 * The seeds this heavy scenario sweeps — DELIBERATELY bounded to the first CI seed (testing-guide
 * §3.7 D-CHAOS-SCALE), and flagged here rather than silently chosen. Mirrors CHAOS-02/03: the VOLUME
 * is never reduced (every run rebuilds the full 20,000-op history), only the SEED SWEEP is. A
 * 20,000-op rebuild is ~54 s and vitest runs a file's tests SERIALLY, so seeds 1–10 would serialize
 * this one file to ~9 min and become the merge gate's long pole. `CHAOS_SEEDS=…` (a reproduction) or
 * `CHAOS_NIGHTLY=1` runs every resolved seed, so the nightly still sweeps the full set.
 */
function chaos08Seeds(env: NodeJS.ProcessEnv = process.env): number[] {
  const seeds = resolveSeeds(env);
  const explicit = env.CHAOS_SEEDS !== undefined && env.CHAOS_SEEDS !== '';
  if (explicit || env.CHAOS_NIGHTLY === '1') return seeds;
  return seeds.slice(0, 1);
}

const CLOCK_BASE = 1_726_100_000_000;
const HISTORY = activeVolumes().rebuildHistory; // 20,000 at CI scale (§3.6) — the meta-test pins it.
const INTERLEAVED = activeVolumes().rebuildInterleaved; // 500 mid-stream ops.
const REBUILD_BATCH = 500; // DEFAULT_REBUILD_BATCH_SIZE → 40 batches over 20,000.

/** Author `count` real signed ops (creates + edits) on a device — the incremental control's history. */
async function author(
  device: VirtualDevice,
  prng: Prng,
  count: number,
  noteIds: string[],
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    device.clock.advance(1_000 + (i % 7));
    if (noteIds.length < 40 || prng() < 0.25) {
      noteIds.push(await device.createNote({ title: `n${i}`, body: `b${i}` }));
    } else {
      await device.editNote(noteIds[Math.floor(prng() * noteIds.length)]!, `edit-${i}`);
    }
  }
}

/** Feed a device the ops as PULLED (log insert, NO fold) so a later rebuild folds them once. */
async function loadLogOnly(
  device: VirtualDevice,
  ops: readonly SignedOperation[],
  from: number,
): Promise<number> {
  let seq = from;
  for (const op of ops) {
    seq += 1;
    await insertPulledOp(device.db, op, seq, op.timestamp);
  }
  return seq;
}

function notesOnly(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.filter((op) => op.type.startsWith('notes.'));
}

describe('CHAOS-08 projection rebuild mid-stream', () => {
  for (const seed of chaos08Seeds()) {
    test(`CHAOS-08 kill+resume at 25/50/75% then mid-stream ops: rebuilt == control == canonical fold [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const ids = mintIdentities(seed, 2);
          const [controlId, rebuildId] = ids.devices as readonly [DeviceIdentity, DeviceIdentity];

          // The control authors the whole history incrementally and never rebuilds — the reference.
          const control = await VirtualDevice.open({
            identity: controlId,
            clock: new FakeClock(CLOCK_BASE),
            prng: mulberry32(seed),
          });
          const rebuild = await VirtualDevice.open({
            identity: rebuildId,
            clock: new FakeClock(CLOCK_BASE),
            prng: mulberry32(seed ^ 0x08),
          });
          try {
            const prng = mulberry32(seed ^ 0xa5a5);
            const noteIds: string[] = [];
            await author(control, prng, HISTORY, noteIds);
            const history = notesOnly(await control.wireOps());
            expect(history.length).toBe(HISTORY); // denominator (T-14)

            // The rebuild device holds the identical ops in its LOG (unfolded).
            const seq = await loadLogOnly(rebuild, history, 0);

            const totalBatches = Math.ceil(HISTORY / REBUILD_BATCH);
            const kills = [0.25, 0.5, 0.75].map((f) => Math.max(1, Math.floor(totalBatches * f)));

            // (a) Kill at 25/50/75% of the watermark, resuming from the durable cursor each time.
            let out = await rebuild.rebuild('notes', {
              batchSize: REBUILD_BATCH,
              stopAfterBatches: kills[0]!,
            });
            expect(out.complete).toBe(false);
            expect(out.startedFresh).toBe(true); // the ONE fresh start — clears tables once
            out = await rebuild.rebuild('notes', {
              batchSize: REBUILD_BATCH,
              stopAfterBatches: kills[1]! - kills[0]!,
            });
            expect(out.startedFresh).toBe(false); // resumed, did NOT clear again
            out = await rebuild.rebuild('notes', {
              batchSize: REBUILD_BATCH,
              stopAfterBatches: kills[2]! - kills[1]!,
            });
            expect(out.startedFresh).toBe(false);

            // (b) 500 new ops arrive mid-stream (via pull) BEFORE the rebuild finishes; the control
            // folds them incrementally, the completing rebuild picks them up from the log.
            control.clock.advance(1_000);
            await author(control, prng, INTERLEAVED, noteIds);
            const midStream = notesOnly(await control.wireOps()).slice(HISTORY);
            expect(midStream.length).toBe(INTERLEAVED);
            await loadLogOnly(rebuild, midStream, seq);

            // Resume to completion.
            out = await rebuild.rebuild('notes', { batchSize: REBUILD_BATCH });
            expect(out.complete).toBe(true);
            expect(out.startedFresh).toBe(false);

            // Watermark monotonicity: every op folded EXACTLY ONCE across all resumes — never below the
            // checkpoint. The direct witness: rebuildApplies == the whole history, no double-count.
            const stats = rebuild.stats.snapshot();
            expect(stats.rebuilds).toBe(1); // exactly one fresh start despite three resumes
            expect(stats.rebuildApplies).toBe(HISTORY + INTERLEAVED);

            // Convergence: rebuilt == control's incremental == canonical fold (incl. mid-stream).
            const universe = [...history, ...midStream];
            const reference = await canonicalFold(universe);
            assertConvergence(reference, [
              {
                name: 'control',
                digest: await control.digest(),
                rows: await notesRows(control.db),
              },
              {
                name: 'rebuilt',
                digest: await rebuild.digest(),
                rows: await notesRows(rebuild.db),
              },
            ]);
          } finally {
            await control.close();
            await rebuild.close();
          }
        },
        'CHAOS-08',
      );
    });
  }
});
