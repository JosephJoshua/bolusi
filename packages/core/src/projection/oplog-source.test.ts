// Op-log reads (10-db §9.2). The engine trusts the SQL canonical order — `ORDER BY
// timestamp_ms, device_id, seq` on `idx_operations_entity_canonical` — to equal the shared
// `compareCanonicalOrder` (05 §4). That holds because lowercase-hex ids sort identically under
// SQLite's BINARY collation and the comparator (10-db §2). This suite is the guard for that
// assumption: if the SQL order ever diverged from the comparator, these go red.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mulberry32, shuffle } from '@bolusi/test-support';

import { hasNewerEntityOp, readCanonicalPage, readEntityOps, sortCanonical } from '../index.js';
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

  const page = await readCanonicalPage(harness.db, NOTES_TYPES, null, 10_000);
  expect(page.map((o) => o.id)).toEqual(sortCanonical(ops).map((o) => o.id));

  // ...and per entity, the same equivalence.
  const entityIds = [...new Set(ops.map((o) => o.entityId))];
  expect(entityIds.length).toBeGreaterThan(1); // fixture is non-trivial (T-14b)
  for (const entityId of entityIds) {
    const entityOps = ops.filter((o) => o.entityId === entityId);
    const read = await readEntityOps(harness.db, 'note', entityId);
    expect(read.map((o) => o.id)).toEqual(sortCanonical(entityOps).map((o) => o.id));
  }
});

test('readCanonicalPage resumes strictly after a cursor', async () => {
  const ops = generateNotesScript(7, { deviceCount: 3, opsPerDevice: 20 }).map((g) => g.op);
  for (const op of ops) await insertOpRow(harness.db, op, null);
  const all = await readCanonicalPage(harness.db, NOTES_TYPES, null, 10_000);

  const firstPage = await readCanonicalPage(harness.db, NOTES_TYPES, null, 10);
  expect(firstPage.map((o) => o.id)).toEqual(all.slice(0, 10).map((o) => o.id));

  const tenth = firstPage[9];
  if (tenth === undefined) throw new Error('fixture must yield at least 10 ops');
  const rest = await readCanonicalPage(
    harness.db,
    NOTES_TYPES,
    { timestamp: tenth.timestamp, deviceId: tenth.deviceId, seq: tenth.seq },
    10_000,
  );
  // Strictly after: the cursor op itself is excluded, and no earlier op reappears.
  expect(rest.map((o) => o.id)).toEqual(all.slice(10).map((o) => o.id));
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
