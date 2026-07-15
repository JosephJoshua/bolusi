// Order-independent convergence (FR-1118 / 04 §4.2) — the load-bearing property of the whole
// engine, and a classic silent-failure zone. Ops arrive out of order routinely; the projection
// MUST converge to the same result regardless of arrival order. Precursor to CHAOS-01/06/07.
//
// The oracle (testing-guide §3.4) is the single reference for "converged": digestModule over
// the notes projection. The canonical-fold reference is a fresh DB fed all ops strictly in
// canonical order. Every seed prints on failure (T-6); the property is asserted over MANY
// random permutations (T-12: the class, not three hand-picked orders).
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
  ops.map((op) => ({ op: op as GeneratedOp['op'], serverSeq: null }));

describe('out-of-order convergence property (CHAOS-01 precursor)', () => {
  test('every random permutation digests byte-equal to the canonical fold, seeds 1..10', async () => {
    let totalHead = 0;
    let totalRefold = 0;

    for (let seed = 1; seed <= 10; seed += 1) {
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

      const permPrng = mulberry32(seed ^ 0x9e3779b9);
      for (let perm = 0; perm < 6; perm += 1) {
        const arrival = shuffle(permPrng, generated);
        const harness = await openProjectionHarness();
        await deliverPulled(harness, arrival);
        const digest = await harness.digest();
        const stats = harness.engine.stats.snapshot();
        totalHead += stats.headApplies;
        totalRefold += stats.refolds;
        expect(digest, `seed=${seed} perm=${perm}: diverged from canonical fold`).toBe(
          referenceDigest,
        );
        await harness.close();
      }
    }

    // Both §4.2 paths must have run, else the property proved nothing (CHAOS-01 inconclusive).
    expect(totalHead, 'no head-applies observed — inconclusive').toBeGreaterThan(0);
    expect(totalRefold, 'no re-folds observed — inconclusive').toBeGreaterThan(0);
  });

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
