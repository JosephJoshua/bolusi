// Order-independent convergence (FR-1118 / 04 §4.2) — the load-bearing property of the whole
// engine, and a classic silent-failure zone. Ops arrive out of order routinely; the projection
// MUST converge to the same result regardless of arrival order. Precursor to CHAOS-01/06/07.
//
// The oracle (testing-guide §3.4) is the single reference for "converged": digestModule over
// the notes projection. The canonical-fold reference is a fresh DB fed all ops strictly in
// canonical order. Every seed prints on failure (T-6); the property is asserted over MANY
// random permutations (T-12: the class, not three hand-picked orders).
//
// One case PER SEED (T-2), not one case for all ten. This is not cosmetic: as a single 10-seed
// loop the test did ~4.85s of work against vitest's 5s default — 97% of its budget at idle — and
// timed out under any concurrent load (task 35). A timeout fires no assertion, so the `seed=`
// messages below never printed: a real divergence and a busy machine produced byte-identical CI
// output. Per-seed cases put the seed in the test NAME (reportable even on timeout, T-6) and cut
// each case to ~0.5s, ~1/10th of the smallest ceiling. Coverage is unchanged — the same 10 seeds
// x 6 permutations x 120 ops; only the test boundaries moved.
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';
import { mulberry32, shuffle } from '@bolusi/test-support';
import type { Kysely } from 'kysely';

import { sortCanonical } from '../index.js';
import { countRows, deliverPulled, openProjectionHarness } from '../../test/projection/db.js';
import {
  generateNotesScript,
  makeNoteOp,
  type GeneratedOp,
} from '../../test/projection/notes-fixture.js';

/** SUM(edit_count) — the testability column (§3.2): reveals any double-apply or drop. */
async function sumEditCounts(db: Kysely<ClientDatabase>): Promise<number> {
  const result = await sql<{ s: number | null }>`SELECT SUM(edit_count) AS s FROM notes`.execute(
    db,
  );
  return result.rows[0]?.s ?? 0;
}

const asPulled = (ops: readonly { id: string }[]): GeneratedOp[] =>
  ops.map((op) => ({ op: op as GeneratedOp['op'], arrivalSeq: null }));

/** Seeds the convergence property is asserted over. One test case each (T-2). */
const CONVERGENCE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
/** Random arrival orders per seed — the class of orders, not hand-picked ones (T-12). */
const PERMUTATIONS_PER_SEED = 6;

describe('out-of-order convergence property (CHAOS-01 precursor)', () => {
  test.each(CONVERGENCE_SEEDS)(
    'seed %i: every random permutation digests byte-equal to the canonical fold',
    async (seed) => {
      const generated = generateNotesScript(seed, { deviceCount: 3, opsPerDevice: 40 });
      const ops = generated.map((g) => g.op);

      // Canonical-fold reference: fresh DB, all ops strictly in canonical order (§3.4).
      const reference = await openProjectionHarness();
      const appliedRef = await deliverPulled(reference, asPulled(sortCanonical(ops)));
      expect(appliedRef, `seed=${seed}`).toBe(ops.length);
      // T-14b: prove non-trivial state exists before believing any equality.
      expect(await countRows(reference.db, 'notes'), `seed=${seed}`).toBeGreaterThan(0);
      // A canonical-order feed is all head-case — the reference itself never re-folds.
      expect(reference.engine.stats.snapshot().refolds, `seed=${seed}`).toBe(0);
      const referenceDigest = await reference.digest();
      await reference.close();

      let headApplies = 0;
      let refolds = 0;
      const permPrng = mulberry32(seed ^ 0x9e3779b9);
      for (let perm = 0; perm < PERMUTATIONS_PER_SEED; perm += 1) {
        const arrival = shuffle(permPrng, generated);
        const harness = await openProjectionHarness();
        await deliverPulled(harness, arrival);
        const digest = await harness.digest();
        const stats = harness.engine.stats.snapshot();
        headApplies += stats.headApplies;
        refolds += stats.refolds;
        expect(digest, `seed=${seed} perm=${perm}: diverged from canonical fold`).toBe(
          referenceDigest,
        );
        await harness.close();
      }

      // Both §4.2 paths must have run FOR THIS SEED, else this seed proved nothing (T-14: a case
      // asserts its own coverage). Stronger than the old cross-seed total, which one busy seed
      // could satisfy while nine others silently exercised neither path.
      expect(headApplies, `seed=${seed}: no head-applies observed — inconclusive`).toBeGreaterThan(
        0,
      );
      expect(refolds, `seed=${seed}: no re-folds observed — inconclusive`).toBeGreaterThan(0);
    },
  );

  test('mid-history insert re-folds to the canonical fold with no double-apply or drop', async () => {
    const seed = 314;
    const generated = generateNotesScript(seed, { deviceCount: 3, opsPerDevice: 30 });
    const canonical = sortCanonical(generated.map((g) => g.op));

    const reference = await openProjectionHarness();
    await deliverPulled(reference, asPulled(canonical));
    const referenceDigest = await reference.digest();
    const referenceEdits = await sumEditCounts(reference.db);
    expect(referenceEdits).toBeGreaterThan(0); // T-14b
    await reference.close();

    // Withhold a mid-history EDIT, apply the rest in canonical order, then insert the mid op.
    const midEditIndex = canonical.findIndex(
      (op, i) => i >= Math.floor(canonical.length / 2) && op.type === 'notes.note_body_edited',
    );
    expect(midEditIndex).toBeGreaterThan(0);
    const withheld = canonical[midEditIndex];
    const rest = canonical.filter((_, i) => i !== midEditIndex);

    const harness = await openProjectionHarness();
    await deliverPulled(harness, asPulled(rest));
    await deliverPulled(harness, asPulled([withheld as (typeof canonical)[number]]));
    // The mid op sorts before already-applied ops for its entity → it re-folded.
    expect(harness.engine.stats.snapshot().refolds).toBeGreaterThan(0);

    expect(await harness.digest()).toBe(referenceDigest);
    // edit_count sum identical ⇒ the mid edit was folded exactly once, none lost (§3.2).
    expect(await sumEditCounts(harness.db)).toBe(referenceEdits);
    await harness.close();
  });

  test('re-delivering applied ops is a no-op — digest and edit_count byte-identical (CHAOS-06)', async () => {
    const generated = generateNotesScript(7, { deviceCount: 3, opsPerDevice: 30 });
    const harness = await openProjectionHarness();

    const appliedFirst = await deliverPulled(harness, shuffle(mulberry32(7), generated));
    expect(appliedFirst).toBe(generated.length);
    expect(await countRows(harness.db, 'notes')).toBeGreaterThan(0); // T-14b
    const digestBefore = await harness.digest();
    const editsBefore = await sumEditCounts(harness.db);

    // Re-deliver the identical op ids in a different order: every one dedups at insert (05 §5),
    // so applyOp is never called again — a true no-op.
    const appliedAgain = await deliverPulled(harness, shuffle(mulberry32(77), generated));
    expect(appliedAgain).toBe(0);
    expect(await harness.digest()).toBe(digestBefore);
    expect(await sumEditCounts(harness.db)).toBe(editsBefore);
    await harness.close();
  });

  test('deterministic tie-break: identical timestamp, greater deviceId wins, every permutation (CHAOS-07ii)', async () => {
    const create = makeNoteOp({
      id: 'op-create',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'dev-a',
      seq: 1,
      payload: { title: 'T', body: 'orig' },
    });
    // Two edits at the IDENTICAL timestamp from distinct devices. Canonical tie-break is
    // deviceId ASC, so dev-b (greater) sorts LAST and wins the body.
    const editA = makeNoteOp({
      id: 'op-edit-a',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 5000,
      deviceId: 'dev-a',
      seq: 2,
      payload: { body: 'from-a' },
    });
    const editB = makeNoteOp({
      id: 'op-edit-b',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 5000,
      deviceId: 'dev-b',
      seq: 1,
      payload: { body: 'from-b' },
    });
    const ops = [create, editA, editB];

    for (const arrival of permutations(ops)) {
      const harness = await openProjectionHarness();
      await deliverPulled(harness, asPulled(arrival));
      const row = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
      expect(row.body, `arrival=${arrival.map((o) => o.id).join(',')}`).toBe('from-b');
      expect(row.editCount).toBe(2); // both edits counted — none lost even when overwritten
      await harness.close();
    }
  });

  test('deterministic tie-break: identical timestamp AND deviceId, greater seq wins, every permutation (CHAOS-07ii-seq)', async () => {
    const create = makeNoteOp({
      id: 'op-create-seq',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'dev-a',
      seq: 1,
      payload: { title: 'T', body: 'orig' },
    });
    // Two edits from the SAME device at the IDENTICAL timestamp — the intra-device
    // same-millisecond case CHAOS-07ii above cannot reach. CHAOS-07ii ties two DIFFERENT
    // devices, so `deviceId` resolves the comparison and `seq` is never consulted. Here
    // timestamp AND deviceId both tie, so `seq` is the SOLE discriminator: the canonical
    // order is seq ASC (05 §4), so the greater seq sorts LAST and wins the body. This is the
    // third canonical-order component, which nothing else exercises through the SQL fold
    // (`ORDER BY timestamp_ms, device_id, seq` in oplog-source.ts) — task 38.
    const editLowSeq = makeNoteOp({
      id: 'op-edit-low-seq',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 5000,
      deviceId: 'dev-a',
      seq: 2,
      payload: { body: 'from-seq-2' },
    });
    const editHighSeq = makeNoteOp({
      id: 'op-edit-high-seq',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 5000,
      deviceId: 'dev-a',
      seq: 3,
      payload: { body: 'from-seq-3' },
    });

    // T-14b — assert the PRECONDITION, not just the outcome: the two edits genuinely tie on
    // (timestamp, deviceId) and differ ONLY in seq. A tie test whose ops don't actually tie is
    // this exact bug wearing a fix's clothing — the assertion would pass without seq ever
    // resolving anything.
    expect(editLowSeq.timestamp).toBe(editHighSeq.timestamp);
    expect(editLowSeq.deviceId).toBe(editHighSeq.deviceId);
    expect(editLowSeq.seq).not.toBe(editHighSeq.seq);

    const ops = [create, editLowSeq, editHighSeq];

    let refolds = 0;
    for (const arrival of permutations(ops)) {
      const harness = await openProjectionHarness();
      await deliverPulled(harness, asPulled(arrival));
      refolds += harness.engine.stats.snapshot().refolds;
      const row = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
      // Greater seq is canonically last ⇒ its body wins, on every arrival order.
      expect(row.body, `arrival=${arrival.map((o) => o.id).join(',')}`).toBe('from-seq-3');
      expect(row.editCount).toBe(2); // both edits counted — none lost even when overwritten
      await harness.close();
    }

    // T-14 — a case asserts its own coverage. The SQL `ORDER BY … seq` is consulted ONLY on the
    // re-fold path; if no arrival re-folded, this case would never exercise the seq tie-break in
    // the fold and the gap would silently reopen. Prove at least one permutation re-folded.
    expect(
      refolds,
      'no re-fold observed — the seq tie-break in the SQL fold went untested',
    ).toBeGreaterThan(0);
  });
});

/** All permutations of a small array (test 8 exhausts the 3! arrival orders). */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) result.push([items[i] as T, ...perm]);
  }
  return result;
}
