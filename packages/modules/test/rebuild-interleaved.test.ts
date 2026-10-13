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

test('paused rebuild plus an out-of-order pull converges to the canonical notes fold', async () => {
  const note = noteId(216);
  const history = [
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: note,
        timestamp: 1000,
        payload: { title: 'Interleaved', body: 'first' },
      },
      2161,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: note,
        timestamp: 3000,
        payload: { body: 'last' },
      },
      2162,
    ),
  ];
  const pulled = op(
    {
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId: note,
      deviceId: DEVICE_B,
      timestamp: 2000,
      payload: { body: 'middle' },
    },
    2163,
  );
  const reference = await openClientEngine();
  const interrupted = await openClientEngine();
  engines = [reference, interrupted];

  for (const operation of [...history, pulled])
    await deliver(reference.db, reference.engine, operation);
  const canonicalDigest = await digest(reference);
  const canonicalRow = await sql<{ editCount: number; body: string }>`
    SELECT edit_count AS "editCount", body FROM notes WHERE id = ${note}
  `.execute(reference.db);
  expect(canonicalRow.rows[0]).toEqual({ editCount: 2, body: 'last' });

  for (const operation of history) await deliver(interrupted.db, interrupted.engine, operation);
  const partial = await interrupted.engine.rebuild('notes', { batchSize: 1, stopAfterBatches: 1 });
  expect(partial.complete).toBe(false);
  expect(partial.appliedCount).toBe(1);

  await insertOp(interrupted.db, pulled, 1);
  expect((await interrupted.engine.applyPulledOp(pulled)).mode).toBe('refold');
  expect((await interrupted.engine.readWatermarks('notes')).appliedServerSeq).toBe(1);
  expect(await createSqlRebuildStore(interrupted.db).readCursor('notes')).toEqual({
    phase: 'invalidated',
  });

  const resumed = await interrupted.engine.rebuild('notes', { batchSize: 1 });
  expect(resumed.complete).toBe(true);
  expect(resumed.startedFresh).toBe(true);
  expect(resumed.appliedCount).toBe(3);
  const actual = await sql<{ editCount: number; body: string }>`
    SELECT edit_count AS "editCount", body FROM notes WHERE id = ${note}
  `.execute(interrupted.db);
  expect(actual.rows[0]).toEqual({ editCount: 2, body: 'last' });
  expect(await digest(interrupted)).toBe(canonicalDigest);
  expect((await interrupted.engine.readWatermarks('notes')).appliedServerSeq).toBe(1);
});
