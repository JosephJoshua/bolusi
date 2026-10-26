// Op-log reads (10-db §9.2). The engine trusts the SQL canonical order — `ORDER BY
// timestamp_ms, device_id, seq` on `idx_operations_entity_canonical` — to equal the shared
// `compareCanonicalOrder` (05 §4). That holds because lowercase-hex ids sort identically under
// SQLite's BINARY collation and the comparator (10-db §2). This suite is the guard for that
// assumption: if the SQL order ever diverged from the comparator, these go red.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mulberry32, shuffle } from '@bolusi/test-support';

import {
  hasNewerEntityOp,
  readEntitiesOps,
  readEntityOps,
  readEntityPage,
  sortCanonical,
} from '../index.js';
import {
  insertOpRow,
  openProjectionHarness,
  type ProjectionHarness,
} from '../../test/projection/db.js';
import {
  generateNotesScript,
  makeNoteOp,
  notesModule,
} from '../../test/projection/notes-fixture.js';

const NOTES_TYPES = Object.keys(notesModule.appliers);

let harness: ProjectionHarness;
beforeEach(async () => {
  harness = await openProjectionHarness();
});
afterEach(async () => {
  await harness.close();
});

test('SQL canonical order equals the shared comparator, whatever the insert order', async () => {
  const ops = generateNotesScript(42, { deviceCount: 4, opsPerDevice: 30 }).map((g) => g.op);
  // Populate the log in a SHUFFLED order — the SQL ORDER BY must undo it deterministically.
  for (const op of shuffle(mulberry32(42), ops)) await insertOpRow(harness.db, op, null);

  // Per entity, one read for all of them, and one read each.
  const entityIds = [...new Set(ops.map((o) => o.entityId))];
  expect(entityIds.length).toBeGreaterThan(1); // fixture is non-trivial (T-14b)
  const batched = await readEntitiesOps(harness.db, 'note', entityIds);
  expect([...batched.keys()].sort()).toEqual([...entityIds].sort());
  for (const entityId of entityIds) {
    const expected = sortCanonical(ops.filter((o) => o.entityId === entityId)).map((o) => o.id);
    expect(batched.get(entityId)?.map((o) => o.id)).toEqual(expected);
    const read = await readEntityOps(harness.db, 'note', entityId);
    expect(read.map((o) => o.id)).toEqual(expected);
  }
});

test('readEntityPage walks distinct entities in order and resumes strictly after a cursor', async () => {
  const ops = generateNotesScript(7, { deviceCount: 3, opsPerDevice: 20 }).map((g) => g.op);
  for (const op of ops) await insertOpRow(harness.db, op, null);
  const entityIds = [...new Set(ops.map((o) => o.entityId))].sort();
  expect(entityIds.length).toBeGreaterThan(3); // T-14b

  const all = await readEntityPage(harness.db, NOTES_TYPES, null, 10_000);
  expect(all).toEqual(entityIds.map((entityId) => ({ entityType: 'note', entityId })));

  const firstPage = await readEntityPage(harness.db, NOTES_TYPES, null, 3);
  expect(firstPage).toEqual(all.slice(0, 3));
  const rest = await readEntityPage(harness.db, NOTES_TYPES, firstPage[2]!, 10_000);
  // Strictly after: the cursor entity itself is excluded, and no earlier entity reappears.
  expect(rest).toEqual(all.slice(3));

  // Only entities with an op of the given types are walked.
  expect(await readEntityPage(harness.db, ['notes.no_such_type'], null, 10)).toEqual([]);
});

test('hasNewerEntityOp reports whether a canonically-newer op is already present', async () => {
  const create = makeNoteOp({
    id: 'a',
    entityId: 'n1',
    type: 'notes.note_created',
    timestamp: 1000,
    deviceId: 'dev-a',
    seq: 1,
    payload: { title: 'T', body: 'b' },
  });
  const edit = makeNoteOp({
    id: 'b',
    entityId: 'n1',
    type: 'notes.note_body_edited',
    timestamp: 2000,
    deviceId: 'dev-a',
    seq: 2,
    payload: { body: 'b2' },
  });
  await insertOpRow(harness.db, create, null);
  await insertOpRow(harness.db, edit, null);

  expect(await hasNewerEntityOp(harness.db, create)).toBe(true); // edit is newer
  expect(await hasNewerEntityOp(harness.db, edit)).toBe(false); // edit is the max
  expect(
    await hasNewerEntityOp(harness.db, {
      entityType: 'note',
      entityId: 'absent',
      timestamp: 0,
      deviceId: 'z',
      seq: 1,
    }),
  ).toBe(false); // no ops for that entity
});

test('reconstructed ops preserve payload, timestamp, and the schemaVersion-2 seam', async () => {
  const v2 = makeNoteOp({
    id: 'c',
    entityId: 'n2',
    type: 'notes.note_created',
    timestamp: 1_700_000_000_123,
    deviceId: 'dev-b',
    seq: 5,
    schemaVersion: 2,
    payload: { title: 'Title', body: 'Body', mediaId: 'media-9' },
  });
  await insertOpRow(harness.db, v2, 3);
  const [read] = await readEntityOps(harness.db, 'note', 'n2');
  expect(read).toMatchObject({
    id: 'c',
    entityId: 'n2',
    schemaVersion: 2,
    timestamp: 1_700_000_000_123,
    deviceId: 'dev-b',
    seq: 5,
    payload: { title: 'Title', body: 'Body', mediaId: 'media-9' },
  });
});
