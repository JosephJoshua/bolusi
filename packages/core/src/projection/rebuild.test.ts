// Full rebuild (04 §4.3): incremental == rebuild at CI scale, a projectionVersion bump triggers a
// rebuild, an interrupted rebuild resumes after its entity cursor without re-folding anything at or
// before it, and the projection stays whole and correct while applies run between batches.
// Precursors to CHAOS-08 / CHAOS-08a.
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';
import { mulberry32, shuffle } from '@bolusi/test-support';

import { createProjectionEngine, createSqlRebuildStore, ProjectionRegistry } from '../index.js';
import {
  countRows,
  deliverPulled,
  openProjectionHarness,
  type ProjectionHarness,
} from '../../test/projection/db.js';
import {
  generateNotesScript,
  makeRecordingNotesModule,
  notesModule,
  notesModuleAtVersion,
  type GeneratedOp,
} from '../../test/projection/notes-fixture.js';

/** The script's entity ids in the rebuild's walk order. */
const entitiesInOrder = (generated: readonly GeneratedOp[]): string[] =>
  [...new Set(generated.map((g) => g.op.entityId))].sort();

const opsOf = (generated: readonly GeneratedOp[], entityIds: readonly string[]): number =>
  generated.filter((g) => entityIds.includes(g.op.entityId)).length;

async function noteIds(harness: ProjectionHarness): Promise<string[]> {
  const result = await sql<{ id: string }>`SELECT id FROM notes ORDER BY id`.execute(harness.db);
  return result.rows.map((row) => row.id);
}

describe('rebuild == incremental (CHAOS-08 precursor)', () => {
  test('a full rebuild reproduces the incremental projection byte-for-byte at ≥2000 ops (I-8: projections are disposable and rebuildable from the log)', async () => {
    // 4 devices × 520 = 2080 ops (CI-scale, > 2000).
    const generated = generateNotesScript(808, { deviceCount: 4, opsPerDevice: 520 });
    expect(generated.length).toBeGreaterThanOrEqual(2000);

    const harness = await openProjectionHarness();
    // Incremental apply in shuffled arrival order — exercises both head and re-fold.
    await deliverPulled(harness, shuffle(mulberry32(808), generated));
    expect(await countRows(harness.db, 'notes')).toBeGreaterThan(0); // T-14b
    const incrementalDigest = await harness.digest();
    expect(harness.engine.stats.snapshot().refolds).toBeGreaterThan(0);

    // Re-fold every entity from the SAME op log.
    const outcome = await harness.engine.rebuild('notes');
    expect(outcome.complete).toBe(true);
    expect(outcome.appliedCount).toBe(generated.length); // every notes op replayed
    expect(await harness.digest()).toBe(incrementalDigest);
    await harness.close();
  });

  test('a projectionVersion bump triggers exactly one rebuild (04 §4.4)', async () => {
    const generated = generateNotesScript(9, { deviceCount: 3, opsPerDevice: 40 });
    const harness = await openProjectionHarness([notesModule]);
    await deliverPulled(harness, generated);
    const baseline = await harness.digest();

    // First version check: nothing recorded yet → rebuilds and records v1.
    expect((await harness.engine.rebuildIfVersionChanged('notes')).rebuilt).toBe(true);
    // Same manifest again → no rebuild.
    expect((await harness.engine.rebuildIfVersionChanged('notes')).rebuilt).toBe(false);

    // App upgrade: a second engine over the SAME db with a bumped projectionVersion.
    const bumped = new ProjectionRegistry<ClientDatabase>();
    bumped.register(notesModuleAtVersion(2));
    const upgraded = createProjectionEngine(harness.db, bumped);
    expect((await upgraded.rebuildIfVersionChanged('notes')).rebuilt).toBe(true);
    // ...and it settles: the bumped version is now recorded.
    expect((await upgraded.rebuildIfVersionChanged('notes')).rebuilt).toBe(false);

    // The projection content is unchanged by the version churn (same columns/appliers).
    expect(await harness.digest()).toBe(baseline);
    await harness.close();
  });
});

test('same-version check resumes an interrupted cursor instead of treating the version as complete', async () => {
  const generated = generateNotesScript(217, { deviceCount: 2, opsPerDevice: 8 });
  const [first] = entitiesInOrder(generated);
  const firstOps = opsOf(generated, [first!]);
  const harness = await openProjectionHarness();
  try {
    await deliverPulled(harness, generated);
    expect((await harness.engine.rebuildIfVersionChanged('notes')).rebuilt).toBe(true);
    const baseline = await harness.digest();
    expect((await harness.engine.rebuildIfVersionChanged('notes')).rebuilt).toBe(false);

    const partial = await harness.engine.rebuild('notes', { batchSize: 1, stopAfterBatches: 1 });
    expect(partial.complete).toBe(false);
    expect(partial.appliedCount).toBe(firstOps);
    expect((await createSqlRebuildStore(harness.db).readCursor('notes'))?.after).toEqual({
      entityType: 'note',
      entityId: first,
    });

    const restarted = createProjectionEngine(harness.db, harness.registry);
    const resume = await restarted.rebuildIfVersionChanged('notes', { batchSize: 1 });
    expect(resume.rebuilt).toBe(true);
    expect(resume.outcome?.complete).toBe(true);
    expect(resume.outcome?.startedFresh).toBe(false);
    expect(resume.outcome?.appliedCount).toBe(generated.length - firstOps);
    expect(await harness.digest()).toBe(baseline);
    expect((await restarted.rebuildIfVersionChanged('notes')).rebuilt).toBe(false);
  } finally {
    await harness.close();
  }
});

test('a cursor left by another projection version restarts from the first entity', async () => {
  const generated = generateNotesScript(31, { deviceCount: 2, opsPerDevice: 20 });
  const harness = await openProjectionHarness();
  try {
    await deliverPulled(harness, generated);
    const baseline = await harness.digest();
    const partial = await harness.engine.rebuild('notes', { batchSize: 1, stopAfterBatches: 2 });
    expect(partial.complete).toBe(false);

    // The app updates mid-rebuild: the entities before the cursor were folded by the old appliers.
    const bumped = new ProjectionRegistry<ClientDatabase>();
    bumped.register(notesModuleAtVersion(2));
    const upgraded = createProjectionEngine(harness.db, bumped);
    const outcome = await upgraded.rebuild('notes');
    expect(outcome.startedFresh).toBe(true);
    expect(outcome.complete).toBe(true);
    expect(outcome.appliedCount).toBe(generated.length);
    expect((await upgraded.rebuildIfVersionChanged('notes')).rebuilt).toBe(false);
    expect(await harness.digest()).toBe(baseline);
  } finally {
    await harness.close();
  }
});

describe('interrupted-rebuild resume (CHAOS-08a precursor)', () => {
  test('resume continues after the entity cursor at ~25/50/75%, re-folding nothing at or before it', async () => {
    const generated = generateNotesScript(600, { deviceCount: 4, opsPerDevice: 100 }); // 400 ops
    const entities = entitiesInOrder(generated);
    const batchSize = 4;
    const totalBatches = Math.ceil(entities.length / batchSize);
    expect(totalBatches).toBeGreaterThanOrEqual(8); // T-14b

    // Uninterrupted reference digest on the same op set.
    const reference = await openProjectionHarness();
    await deliverPulled(reference, shuffle(mulberry32(600), generated));
    await reference.engine.rebuild('notes', { batchSize });
    const referenceDigest = await reference.digest();
    await reference.close();

    for (const fraction of [0.25, 0.5, 0.75]) {
      const stopAfterBatches = Math.floor(totalBatches * fraction);
      const recording = makeRecordingNotesModule();
      const harness = await openProjectionHarness([recording.module]);
      await deliverPulled(harness, shuffle(mulberry32(600), generated));

      // Discard the incremental-apply observations — we only care about the rebuild.
      recording.observed.length = 0;

      // Interrupt after `stopAfterBatches` (models a crash: state discarded, DB reopened — here a
      // fresh engine object over the same persisted DB).
      const partial = await harness.engine.rebuild('notes', { batchSize, stopAfterBatches });
      expect(partial.complete, `stop=${stopAfterBatches}`).toBe(false);
      const folded = entities.slice(0, stopAfterBatches * batchSize);
      const appliedBeforeInterrupt = recording.observed.length;
      expect(appliedBeforeInterrupt).toBe(opsOf(generated, folded));

      const cursorState = await createSqlRebuildStore(harness.db).readCursor('notes');
      expect(cursorState?.after).toEqual({ entityType: 'note', entityId: folded.at(-1) });

      // Resume on a FRESH engine over the same DB — no in-memory state carried over.
      const resumed = createProjectionEngine(harness.db, harness.registry);
      const finish = await resumed.rebuild('notes', { batchSize });
      expect(finish.complete).toBe(true);
      expect(finish.startedFresh).toBe(false); // it RESUMED, did not restart

      // Nothing at or before the cursor entity was re-folded.
      for (const obs of recording.observed.slice(appliedBeforeInterrupt)) {
        expect(folded, `stop=${stopAfterBatches} re-folded ${obs.entityId}`).not.toContain(
          obs.entityId,
        );
      }

      // Every op applied exactly once across interrupt + resume — none dropped, none doubled.
      const appliedIds = recording.observed.map((o) => o.id);
      expect(appliedIds.length).toBe(generated.length);
      expect(new Set(appliedIds).size).toBe(generated.length);

      // Final projection == the uninterrupted rebuild.
      expect(await harness.digest(notesModule), `stop=${stopAfterBatches}`).toBe(referenceDigest);
      await harness.close();
    }
  });
});

describe('a rebuild in progress keeps the app working', () => {
  test('every entity keeps its rows between batches', async () => {
    const generated = generateNotesScript(44, { deviceCount: 3, opsPerDevice: 30 });
    const harness = await openProjectionHarness();
    try {
      await deliverPulled(harness, generated);
      const before = await noteIds(harness);
      expect(before.length).toBeGreaterThan(4); // T-14b

      let batches = 0;
      for (;;) {
        const step = await harness.engine.rebuild('notes', { batchSize: 2, stopAfterBatches: 1 });
        // A screen reading between batches sees every note, never a half-emptied table.
        expect(await noteIds(harness)).toEqual(before);
        if (step.complete) break;
        batches += 1;
      }
      expect(batches).toBeGreaterThan(1);
    } finally {
      await harness.close();
    }
  });

  test('pulled ops applied between batches, in and out of order, converge without restarting the rebuild', async () => {
    const generated = shuffle(
      mulberry32(77),
      generateNotesScript(77, { deviceCount: 4, opsPerDevice: 60 }),
    );
    const reference = await openProjectionHarness();
    await deliverPulled(reference, generated);
    const referenceDigest = await reference.digest();
    await reference.close();

    const harness = await openProjectionHarness();
    try {
      const head = Math.floor(generated.length * 0.6);
      await deliverPulled(harness, generated.slice(0, head));
      const late = generated.slice(head);
      const before = harness.engine.stats.snapshot();

      let next = 0;
      let resumes = 0;
      let step = await harness.engine.rebuild('notes', { batchSize: 3, stopAfterBatches: 1 });
      while (!step.complete) {
        // The shop keeps syncing: a few more ops land before the next batch.
        await deliverPulled(harness, late.slice(next, next + 8));
        next += 8;
        step = await harness.engine.rebuild('notes', { batchSize: 3, stopAfterBatches: 1 });
        expect(step.startedFresh).toBe(false);
        resumes += 1;
      }
      expect(next).toBeGreaterThanOrEqual(late.length / 2); // most late ops landed mid-rebuild
      await deliverPulled(harness, late.slice(next));
      expect(resumes).toBeGreaterThan(3);
      const during = harness.engine.stats.snapshot();
      // Both §4.2 paths ran while the rebuild was in flight (T-11: else inconclusive).
      expect(during.headApplies).toBeGreaterThan(before.headApplies);
      expect(during.refolds).toBeGreaterThan(before.refolds);

      expect(await harness.digest()).toBe(referenceDigest);
    } finally {
      await harness.close();
    }
  });
});

describe('rebuildOutdated (the background upgrade)', () => {
  test('rebuilds a bumped module a batch at a time, pausing between batches, then settles', async () => {
    const generated = generateNotesScript(12, { deviceCount: 2, opsPerDevice: 30 });
    const entities = entitiesInOrder(generated).length;
    const harness = await openProjectionHarness();
    try {
      await deliverPulled(harness, generated);
      expect(await harness.engine.rebuildOutdated({ pause: () => Promise.resolve() })).toEqual([
        'notes',
      ]);
      const baseline = await harness.digest();

      const bumped = new ProjectionRegistry<ClientDatabase>();
      bumped.register(notesModuleAtVersion(2));
      const upgraded = createProjectionEngine(harness.db, bumped);
      let pauses = 0;
      const pause = (): Promise<void> => {
        pauses += 1;
        return Promise.resolve();
      };
      expect(await upgraded.rebuildOutdated({ pause, batchSize: 2 })).toEqual(['notes']);
      expect(pauses).toBe(Math.floor(entities / 2));
      expect(await harness.digest()).toBe(baseline);

      pauses = 0;
      expect(await upgraded.rebuildOutdated({ pause, batchSize: 2 })).toEqual([]);
      expect(pauses).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test('stops when asked and resumes on the next call', async () => {
    const generated = generateNotesScript(13, { deviceCount: 2, opsPerDevice: 30 });
    const harness = await openProjectionHarness();
    try {
      await deliverPulled(harness, generated);
      let stopped = false;
      const first = await harness.engine.rebuildOutdated({
        batchSize: 2,
        pause: () => {
          stopped = true;
          return Promise.resolve();
        },
        isStopped: () => stopped,
      });
      expect(first).toEqual([]);
      expect((await createSqlRebuildStore(harness.db).readCursor('notes'))?.after).not.toBeNull();

      const second = await harness.engine.rebuildOutdated({ pause: () => Promise.resolve() });
      expect(second).toEqual(['notes']);
      expect(await createSqlRebuildStore(harness.db).readCursor('notes')).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
