// Full rebuild (04 §4.3): incremental == rebuild at CI scale, projectionVersion bump triggers
// a rebuild, and an interrupted rebuild resumes from its cursor without re-applying anything at
// or below it. Precursors to CHAOS-08 / CHAOS-08a.
import { describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';
import { mulberry32, shuffle } from '@bolusi/test-support';

import {
  compareCanonicalOrder,
  createProjectionEngine,
  createSqlRebuildStore,
  ProjectionRegistry,
  type CanonicalCursor,
} from '../index.js';
import { countRows, deliverPulled, openProjectionHarness } from '../../test/projection/db.js';
import {
  generateNotesScript,
  makeRecordingNotesModule,
  notesModule,
  notesModuleAtVersion,
} from '../../test/projection/notes-fixture.js';

describe('rebuild == incremental (CHAOS-08 precursor)', () => {
  test('a drop-tables full rebuild reproduces the incremental projection byte-for-byte at ≥2000 ops', async () => {
    // 4 devices × 520 = 2080 ops (CI-scale, > 2000).
    const generated = generateNotesScript(808, { deviceCount: 4, opsPerDevice: 520 });
    expect(generated.length).toBeGreaterThanOrEqual(2000);

    const harness = await openProjectionHarness();
    // Incremental apply in shuffled arrival order — exercises both head and re-fold.
    await deliverPulled(harness, shuffle(mulberry32(808), generated));
    expect(await countRows(harness.db, 'notes')).toBeGreaterThan(0); // T-14b
    const incrementalDigest = await harness.digest();
    expect(harness.engine.stats.snapshot().refolds).toBeGreaterThan(0);

    // Drop tables + full canonical replay on the SAME op log.
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

describe('interrupted-rebuild resume (CHAOS-08a precursor)', () => {
  test('resume continues from the cursor at ~25/50/75%, re-applying nothing at or below it', async () => {
    const generated = generateNotesScript(600, { deviceCount: 4, opsPerDevice: 100 }); // 400 ops
    const batchSize = 20; // 20 batches total

    // Uninterrupted reference digest (drop-tables rebuild on the same op set).
    const reference = await openProjectionHarness();
    await deliverPulled(reference, shuffle(mulberry32(600), generated));
    await reference.engine.rebuild('notes', { batchSize });
    const referenceDigest = await reference.digest();
    await reference.close();

    for (const stopAfterBatches of [5, 10, 15]) {
      const recording = makeRecordingNotesModule();
      const harness = await openProjectionHarness([recording.module]);
      await deliverPulled(harness, shuffle(mulberry32(600), generated));

      // Discard the incremental-apply observations — we only care about the rebuild.
      recording.observed.length = 0;

      // Interrupt the rebuild after `stopAfterBatches` (models a crash: state discarded, DB
      // reopened — here a fresh engine object over the same persisted DB).
      const partial = await harness.engine.rebuild('notes', { batchSize, stopAfterBatches });
      expect(partial.complete, `stop=${stopAfterBatches}`).toBe(false);
      const appliedBeforeInterrupt = recording.observed.length;
      expect(appliedBeforeInterrupt).toBe(stopAfterBatches * batchSize);

      const cursorState = await createSqlRebuildStore(harness.db).readCursor('notes');
      expect(cursorState?.phase).toBe('progress');
      const resumeCursor =
        cursorState?.phase === 'progress' ? cursorState.cursor : ({} as CanonicalCursor);

      // Resume on a FRESH engine over the same DB — no in-memory state carried over.
      const resumed = createProjectionEngine(harness.db, harness.registry);
      const finish = await resumed.rebuild('notes', { batchSize });
      expect(finish.complete).toBe(true);
      expect(finish.startedFresh).toBe(false); // it RESUMED, did not restart

      // Nothing at or below the resume cursor was re-applied.
      const resumeApplied = recording.observed.slice(appliedBeforeInterrupt);
      for (const obs of resumeApplied) {
        expect(
          compareCanonicalOrder(obs.cursor, resumeCursor),
          `stop=${stopAfterBatches} re-applied op ${obs.id} at/below the cursor`,
        ).toBeGreaterThan(0);
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
