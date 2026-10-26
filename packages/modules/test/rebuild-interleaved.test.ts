import { sql } from 'kysely';
import { afterEach, expect, test } from 'vitest';

import {
  createSqlRebuildStore,
  digestModule,
  registerModules,
  type AnyModuleDefinition,
} from '@bolusi/core';
import { noblePort } from '@bolusi/test-support';

import { notesModule } from '../src/notes/index.js';
import {
  DEVICE_B,
  deliver,
  insertOp,
  noteId,
  op,
  openClientEngine,
  type ClientEngine,
} from './support/engines.js';

const projection = registerModules([
  notesModule as unknown as AnyModuleDefinition<never>,
]).projections.module('notes')!;
const digest = (engine: ClientEngine): Promise<string> =>
  digestModule(engine.db, projection, { hash: (data) => noblePort.sha256(data) });

let engines: ClientEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
});

/** A note created at `t`, edited at `t + 2000`; and an out-of-order edit from device B at `t + 1000`. */
function noteScript(n: number, t: number, i: number) {
  const entityId = noteId(n);
  const history = [
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId,
        timestamp: t,
        payload: { title: `Interleaved ${n}`, body: 'first' },
      },
      i,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId,
        timestamp: t + 2000,
        payload: { body: 'last' },
      },
      i + 1,
    ),
  ];
  const pulled = op(
    {
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId,
      deviceId: DEVICE_B,
      timestamp: t + 1000,
      payload: { body: 'middle' },
    },
    i + 2,
  );
  return { entityId, history, pulled };
}

test('paused rebuild plus out-of-order pulls on both sides of its cursor converges to the canonical notes fold', async () => {
  // The rebuild walks entities in id order: `passed` is re-folded by the first batch, `ahead` is not.
  const passed = noteScript(216, 1000, 2161);
  const ahead = noteScript(217, 5000, 2171);
  const history = [...passed.history, ...ahead.history];
  const pulled = [passed.pulled, ahead.pulled];

  const reference = await openClientEngine();
  const interrupted = await openClientEngine();
  engines = [reference, interrupted];

  for (const operation of [...history, ...pulled])
    await deliver(reference.db, reference.engine, operation);
  const canonicalDigest = await digest(reference);
  const rowsOf = async (engine: ClientEngine) =>
    (
      await sql<{ id: string; editCount: number; body: string }>`
        SELECT id, edit_count AS "editCount", body FROM notes ORDER BY id
      `.execute(engine.db)
    ).rows;
  expect(await rowsOf(reference)).toEqual([
    { id: passed.entityId, editCount: 2, body: 'last' },
    { id: ahead.entityId, editCount: 2, body: 'last' },
  ]);

  for (const operation of history) await deliver(interrupted.db, interrupted.engine, operation);
  const partial = await interrupted.engine.rebuild('notes', { batchSize: 1, stopAfterBatches: 1 });
  expect(partial.complete).toBe(false);
  expect(partial.appliedCount).toBe(2);

  let arrival = 0;
  for (const operation of pulled) {
    await insertOp(interrupted.db, operation, (arrival += 1));
    expect((await interrupted.engine.applyPulledOp(operation)).mode).toBe('refold');
  }
  expect((await interrupted.engine.readWatermarks('notes')).appliedServerSeq).toBe(2);
  // The applies did not disturb the rebuild: it still resumes after the entity it last re-folded.
  expect(await createSqlRebuildStore(interrupted.db).readCursor('notes')).toMatchObject({
    after: { entityType: 'note', entityId: passed.entityId },
  });

  const resumed = await interrupted.engine.rebuild('notes', { batchSize: 1 });
  expect(resumed.complete).toBe(true);
  expect(resumed.startedFresh).toBe(false);
  expect(resumed.appliedCount).toBe(3); // `ahead`, with its pulled edit; `passed` is not re-folded
  expect(await rowsOf(interrupted)).toEqual(await rowsOf(reference));
  expect(await digest(interrupted)).toBe(canonicalDigest);
  expect((await interrupted.engine.readWatermarks('notes')).appliedServerSeq).toBe(2);
});
