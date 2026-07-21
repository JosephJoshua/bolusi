// Watermark semantics (04 §4.3): applied_server_seq = highest CONTIGUOUS pulled arrival_seq on the
// client (10-db §9.2, D20 §4 — the server's own server_seq server-side; a gap pins it); applied_local_seq = highest appended own seq (strictly monotonic); an
// entity-local re-fold moves NEITHER; nothing — including rebuild resume — ever decreases them.
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  insertOpRow,
  openProjectionHarness,
  type ProjectionHarness,
} from '../../test/projection/db.js';
import { makeNoteOp } from '../../test/projection/notes-fixture.js';

let harness: ProjectionHarness;
beforeEach(async () => {
  harness = await openProjectionHarness();
});
afterEach(async () => {
  await harness.close();
});

/** Insert a pulled op with an explicit arrival_seq, then apply it. */
async function pull(
  op: ReturnType<typeof makeNoteOp>,
  arrivalSeq: number,
): Promise<Awaited<ReturnType<ProjectionHarness['engine']['applyPulledOp']>>> {
  await insertOpRow(harness.db, op, arrivalSeq);
  return harness.engine.applyPulledOp(op);
}

/** Insert an own-device (local) op, then apply it through the append path. */
async function append(
  op: ReturnType<typeof makeNoteOp>,
): Promise<Awaited<ReturnType<ProjectionHarness['engine']['applyAppendedOp']>>> {
  await insertOpRow(harness.db, op, null);
  return harness.engine.applyAppendedOp(op);
}

const create = (id: string, entityId: string, timestamp: number, seq: number) =>
  makeNoteOp({
    id,
    entityId,
    type: 'notes.note_created',
    timestamp,
    deviceId: 'dev-a',
    seq,
    payload: { title: 'T', body: `b-${id}` },
  });

test('applied_server_seq advances only across contiguous arrival_seq; a gap pins it, a fill catches up', async () => {
  await pull(create('a', 'n1', 1000, 1), 1);
  expect((await harness.engine.readWatermarks('notes')).appliedServerSeq).toBe(1);

  await pull(create('b', 'n2', 2000, 2), 2);
  expect((await harness.engine.readWatermarks('notes')).appliedServerSeq).toBe(2);

  // arrival_seq 4 arrives with a gap at 3 → the watermark pins below the gap. Production can
  // never produce this hole (nextArrivalSeq is MAX+1); it is forced here to prove the walk stops.
  await pull(create('d', 'n3', 3000, 3), 4);
  expect((await harness.engine.readWatermarks('notes')).appliedServerSeq).toBe(2);

  // Fill the gap (arrival_seq 3) → the watermark advances THROUGH 3 and catches up past 4.
  await pull(create('c', 'n4', 4000, 4), 3);
  expect((await harness.engine.readWatermarks('notes')).appliedServerSeq).toBe(4);
});

test('applied_local_seq is strictly monotonic on appends and untouched by a pull', async () => {
  await append(create('a', 'n1', 1000, 1));
  expect((await harness.engine.readWatermarks('notes')).appliedLocalSeq).toBe(1);
  await append(create('b', 'n2', 2000, 2));
  expect((await harness.engine.readWatermarks('notes')).appliedLocalSeq).toBe(2);

  // A pulled (foreign) op advances the server watermark, never the local one.
  await pull(
    makeNoteOp({
      id: 'p',
      entityId: 'n3',
      type: 'notes.note_created',
      timestamp: 3000,
      deviceId: 'dev-b',
      seq: 1,
      payload: { title: 'T', body: 'foreign' },
    }),
    1,
  );
  const wm = await harness.engine.readWatermarks('notes');
  expect(wm.appliedLocalSeq).toBe(2);
  expect(wm.appliedServerSeq).toBe(1);
});

test('an entity-local re-fold moves NEITHER watermark', async () => {
  // Establish a pinned server watermark (gap at 3) with an already-applied newest op for n1.
  await pull(create('a', 'n1', 1000, 1), 1); // server → 1
  await pull(create('b', 'n2', 2000, 2), 2); // server → 2
  await pull(
    makeNoteOp({
      id: 'e-late',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 5000,
      deviceId: 'dev-a',
      seq: 3,
      payload: { body: 'newest' },
    }),
    4, // gap at 3 → server pinned at 2
  );
  const before = await harness.engine.readWatermarks('notes');
  expect(before).toEqual({ appliedServerSeq: 2, appliedLocalSeq: 0 });

  // An out-of-order edit for n1 (sorts before e-late) triggers a re-fold; its arrival_seq (5)
  // is still beyond the gap, so the server watermark does not move, and it is a pull, so the
  // local watermark does not move either.
  const outcome = await pull(
    makeNoteOp({
      id: 'e-early',
      entityId: 'n1',
      type: 'notes.note_body_edited',
      timestamp: 3000,
      deviceId: 'dev-a',
      seq: 4,
      payload: { body: 'earlier' },
    }),
    5,
  );
  expect(outcome.mode).toBe('refold');
  expect(await harness.engine.readWatermarks('notes')).toEqual(before);
});

test('no operation, including rebuild and its resume, ever decreases a watermark', async () => {
  await append(create('la', 'n1', 1000, 1)); // local → 1
  await append(create('lb', 'n2', 2000, 2)); // local → 2
  await pull(
    makeNoteOp({
      id: 'pa',
      entityId: 'n3',
      type: 'notes.note_created',
      timestamp: 3000,
      deviceId: 'dev-b',
      seq: 1,
      payload: { title: 'T', body: 'f1' },
    }),
    1,
  );
  const advanced = await harness.engine.readWatermarks('notes');
  expect(advanced).toEqual({ appliedServerSeq: 1, appliedLocalSeq: 2 });

  // A full rebuild replays the same ops and must leave the watermarks untouched (§4.3).
  await harness.engine.rebuild('notes');
  expect(await harness.engine.readWatermarks('notes')).toEqual(advanced);

  // An interrupted-then-resumed rebuild likewise never lowers them.
  const partial = await harness.engine.rebuild('notes', { batchSize: 1, stopAfterBatches: 1 });
  expect(partial.complete).toBe(false);
  expect(await harness.engine.readWatermarks('notes')).toEqual(advanced);
  await harness.engine.rebuild('notes', { batchSize: 1 });
  expect(await harness.engine.readWatermarks('notes')).toEqual(advanced);
});
