// Projection engine — head/re-fold dispatch (§4.2), failure atomicity, and invalidation (§7).
// Runs on better-sqlite3 :memory: behind the shim dialect (testing-guide §2.3).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';

import {
  compareCanonicalOrder,
  cursorOf,
  type CanonicalCursor,
  type ModuleProjectionManifest,
  type ProjectionApplier,
} from '../index.js';
import {
  countRows,
  deliverPulled,
  insertOpRow,
  openProjectionHarness,
  runInTransaction,
  type ProjectionHarness,
} from '../../test/projection/db.js';
import { notesModule } from '../../test/projection/notes-fixture.js';

let harness: ProjectionHarness;

beforeEach(async () => {
  harness = await openProjectionHarness();
});
afterEach(async () => {
  await harness.close();
});

/** A `notes` op with explicit canonical position — lets a test force head vs out-of-order. */
function noteOp(over: {
  id: string;
  entityId: string;
  type: string;
  timestamp: number;
  deviceId: string;
  seq: number;
  payload?: Record<string, unknown>;
}): SignedOperation {
  return {
    id: over.id,
    tenantId: 'tenant-x',
    storeId: 'store-x',
    userId: 'user-x',
    deviceId: over.deviceId,
    seq: over.seq,
    type: over.type,
    entityType: 'note',
    entityId: over.entityId,
    schemaVersion: 1,
    payload: (over.payload ?? {}) as SignedOperation['payload'],
    timestamp: over.timestamp,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: over.id.padEnd(64, '0'),
    signature: `sig-${over.id}`,
  };
}

interface Observed {
  readonly entityId: string;
  readonly type: string;
  readonly cursor: CanonicalCursor;
}

/** `notes` manifest wrapped so every applier call records the op it observed. */
function makeRecordingNotes(): {
  module: ModuleProjectionManifest<ClientDatabase>;
  observed: Observed[];
} {
  const observed: Observed[] = [];
  const appliers: Record<string, ProjectionApplier<ClientDatabase>> = {};
  for (const [type, applier] of Object.entries(notesModule.appliers)) {
    appliers[type] = async (db, op) => {
      observed.push({ entityId: op.entityId, type: op.type, cursor: cursorOf(op) });
      await applier(db, op);
    };
  }
  return { module: { ...notesModule, appliers }, observed };
}

describe('head vs re-fold dispatch (§4.2)', () => {
  test('canonically-newest op applies head-case: one applier call, no re-fold, no delete', async () => {
    const recording = makeRecordingNotes();
    harness = await recordingHarness(recording.module);

    const create = noteOp({
      id: 'a',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
      payload: { title: 'T', body: 'first' },
    });
    await insertOpRow(harness.db, create, 1);
    const first = await harness.engine.applyPulledOp(create);
    expect(first.mode).toBe('head');

    const edit = noteOp({
      id: 'b',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 2000,
      deviceId: 'd1',
      seq: 2,
      payload: { body: 'second' },
    });
    await insertOpRow(harness.db, edit, 2);
    const second = await harness.engine.applyPulledOp(edit);
    expect(second.mode).toBe('head');

    // Two applier calls total, in arrival order — no re-fold replay happened.
    expect(recording.observed.map((o) => o.type)).toEqual([
      'notes.note_created',
      'notes.note_body_edited',
    ]);
    // editCount survived (a head-apply of the edit did NOT delete the created row).
    const row = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
    expect(row.editCount).toBe(1);
    expect(row.body).toBe('second');
    expect(harness.engine.stats.snapshot()).toMatchObject({ headApplies: 2, refolds: 0 });
  });

  test('an op sorting before an applied op re-folds the entity in canonical order', async () => {
    const recording = makeRecordingNotes();
    harness = await recordingHarness(recording.module);

    // Edit arrives FIRST (newer timestamp) — head-applied on an absent row (a no-op).
    const edit = noteOp({
      id: 'b',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 2000,
      deviceId: 'd1',
      seq: 2,
      payload: { body: 'second' },
    });
    await insertOpRow(harness.db, edit, 1);
    expect((await harness.engine.applyPulledOp(edit)).mode).toBe('head');
    expect(await countRows(harness.db, 'notes')).toBe(0); // edit-before-create is a no-op

    // Create arrives LATE (older timestamp) → out-of-order → delete + full re-fold.
    const create = noteOp({
      id: 'a',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
      payload: { title: 'T', body: 'first' },
    });
    await insertOpRow(harness.db, create, 2);
    const outcome = await harness.engine.applyPulledOp(create);
    expect(outcome.mode).toBe('refold');

    // The re-fold replayed the FULL history [create, edit] strictly in canonical order.
    const refoldSlice = recording.observed.slice(1); // after the first head-applied edit
    expect(refoldSlice.map((o) => o.type)).toEqual([
      'notes.note_created',
      'notes.note_body_edited',
    ]);
    // The applier NEVER saw out-of-order input: every replay slice is canonically sorted.
    expect(isCanonicallySorted(refoldSlice.map((o) => o.cursor))).toBe(true);

    // Final state == canonical fold [create, edit]: the edit is no longer lost.
    const row = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
    expect(row.editCount).toBe(1);
    expect(row.body).toBe('second');
    expect(harness.engine.stats.snapshot()).toMatchObject({ headApplies: 1, refolds: 1 });
  });
});

describe('invalid input / failure atomicity', () => {
  test('an op with no registered applier is a defined no-op (no partial write)', async () => {
    const op = noteOp({
      id: 'u',
      entityId: 'x1',
      type: 'unknown.thing_happened',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
    });
    await insertOpRow(harness.db, op, 1);
    const outcome = await harness.engine.applyPulledOp(op);
    expect(outcome).toMatchObject({ module: null, mode: 'unregistered', writtenTables: [] });
    expect(await countRows(harness.db, 'notes')).toBe(0);
    expect(harness.engine.stats.snapshot().unregistered).toBe(1);
  });

  test('an applier throwing mid-re-fold rolls back: rows not left deleted, watermark unmoved', async () => {
    // A notes module whose edit applier throws on a poisoned payload.
    const poisoned: Record<string, ProjectionApplier<ClientDatabase>> = {
      ...notesModule.appliers,
      'notes.note_body_edited': async (db, op) => {
        if ((op.payload as { poison?: boolean }).poison === true) {
          throw new Error('applier failure mid-re-fold');
        }
        await notesModule.appliers['notes.note_body_edited']?.(db, op);
      },
    };
    harness = await recordingHarness({ ...notesModule, appliers: poisoned });

    // Establish a good state: create + one clean edit (both head, in order).
    const create = noteOp({
      id: 'a',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
      payload: { title: 'T', body: 'first' },
    });
    await insertOpRow(harness.db, create, 1);
    await harness.engine.applyPulledOp(create);
    const cleanEdit = noteOp({
      id: 'b',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 3000,
      deviceId: 'd1',
      seq: 2,
      payload: { body: 'clean' },
    });
    await insertOpRow(harness.db, cleanEdit, 2);
    await harness.engine.applyPulledOp(cleanEdit);

    const before = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
    const watermarkBefore = await harness.engine.readWatermarks('notes');
    expect(before.editCount).toBe(1);

    // A poisoned op sorts BEFORE the clean edit → triggers a re-fold that throws mid-replay.
    const poison = noteOp({
      id: 'c',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 2000, // < the clean edit's 3000 → sorts before it → re-fold
      deviceId: 'd1',
      seq: 3,
      payload: { body: 'poison', poison: true },
    });

    await expect(
      runInTransaction(harness, async () => {
        await insertOpRow(harness.db, poison, 3);
        await harness.engine.applyPulledOp(poison);
      }),
    ).rejects.toThrow('applier failure mid-re-fold');

    // Rolled back: the row is NOT left deleted and holds its pre-re-fold state.
    const after = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
    expect(after.editCount).toBe(before.editCount);
    expect(after.body).toBe(before.body);
    // Watermarks unmoved by the failed apply.
    expect(await harness.engine.readWatermarks('notes')).toEqual(watermarkBefore);
  });
});

describe('live-query invalidation (§7)', () => {
  test('fires once per written table; untouched tables stay silent; re-fold and rebuild fire', async () => {
    let notesFires = 0;
    let untouchedFires = 0;
    const seenSets: ReadonlySet<string>[] = [];
    harness.engine.invalidation.subscribeTable('notes', () => {
      notesFires += 1;
    });
    harness.engine.invalidation.subscribeTable('auth_sessions', () => {
      untouchedFires += 1;
    });
    harness.engine.invalidation.subscribe((tables) => seenSets.push(tables));

    // Head-applies: create + 2 edits (in order) → 3 emissions, each { notes }.
    const create = noteOp({
      id: 'a',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
      payload: { title: 'T', body: 'b0' },
    });
    const edit1 = noteOp({
      id: 'b',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 2000,
      deviceId: 'd1',
      seq: 2,
      payload: { body: 'b1' },
    });
    await deliverPulled(harness, [
      { op: create, serverSeq: null },
      { op: edit1, serverSeq: null },
    ]);
    expect(notesFires).toBe(2);
    expect(untouchedFires).toBe(0);
    expect(seenSets.every((s) => s.has('notes') && s.size === 1)).toBe(true);

    // A re-fold fires invalidation too.
    const late = noteOp({
      id: 'c',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 1500, // between create (1000) and edit1 (2000) → sorts before edit1 → re-fold
      deviceId: 'd1',
      seq: 3,
      payload: { body: 'b-late' },
    });
    await insertOpRow(harness.db, late, 3);
    const outcome = await harness.engine.applyPulledOp(late);
    expect(outcome.mode).toBe('refold');
    expect(notesFires).toBe(3);

    // Rebuild fires per batch.
    await harness.engine.rebuild('notes');
    expect(notesFires).toBeGreaterThan(3);
    expect(untouchedFires).toBe(0);
  });
});

describe('append seam (04 §5.1)', () => {
  test('asAppendSeam applies the op and advances applied_local_seq', async () => {
    const seam = harness.engine.asAppendSeam();
    const create = noteOp({
      id: 'a',
      entityId: 'n1',
      type: 'notes.note_created',
      timestamp: 1000,
      deviceId: 'd1',
      seq: 1,
      payload: { title: 'T', body: 'via-seam' },
    });
    // The append path inserts the op, then invokes the projection seam (04 §5.1 steps 5–6).
    await insertOpRow(harness.db, create, null);
    const result = seam(create);
    expect(result).toBeInstanceOf(Promise);
    await result;

    const row = await harness.db.selectFrom('notes').selectAll().executeTakeFirstOrThrow();
    expect(row.body).toBe('via-seam');
    expect((await harness.engine.readWatermarks('notes')).appliedLocalSeq).toBe(1);
  });
});

/** Open a harness registered to a custom `notes` variant (recording / poisoned). */
async function recordingHarness(
  module: ModuleProjectionManifest<ClientDatabase>,
): Promise<ProjectionHarness> {
  await harness.close();
  return openProjectionHarness([module]);
}

function isCanonicallySorted(cursors: readonly CanonicalCursor[]): boolean {
  for (let i = 1; i < cursors.length; i += 1) {
    if (
      compareCanonicalOrder(cursors[i - 1] as CanonicalCursor, cursors[i] as CanonicalCursor) > 0
    ) {
      return false;
    }
  }
  return true;
}
