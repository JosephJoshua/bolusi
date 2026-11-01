// The refused-changes list names what each change was about ("Servisan K7Q-0042") through the
// module's subject reader, read against a REAL client DB with real migrations.
import { insertOpLogRow, markSyncResult } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { ChainBuilder, makeWorld, noblePort, nodeColumnAead, opRowOf } from '@bolusi/test-support';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';

import { readEntitySyncStatuses } from './entity-sync-statuses.js';

import {
  markRejectionsHandled,
  readSyncStatusRows,
  type RejectedSubjectReaders,
} from './sync-status-reads.js';

const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) };
let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    aead: nodeColumnAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

/** Who made an op, as the op log stores it. */
async function makerOf(opId: string): Promise<string> {
  const row = await db.db
    .selectFrom('operations')
    .select('userId')
    .where('id', '=', opId)
    .executeTakeFirstOrThrow();
  return row.userId;
}

const NAMED = '01920000-0000-7000-8000-0000000d0a01';
const GONE = '01920000-0000-7000-8000-0000000d0a02';

test('a refused change shows the subject its module names, and none when the record is gone', async () => {
  const builder = new ChainBuilder(makeWorld(4401, noblePort), noblePort);
  builder.genesis();
  const ops = [NAMED, GONE].map((entityId) =>
    builder.append({
      type: 'repair.ticket_cancelled',
      entityType: 'repair_ticket',
      entityId,
      payload: { reason: 'x' },
    }),
  );
  for (const op of ops) {
    await insertOpLogRow(db.db, opRowOf(op), {
      syncStatus: 'local',
      syncedAt: null,
      arrivalSeq: null,
    });
    await markSyncResult(db.db as unknown as Parameters<typeof markSyncResult>[0], {
      id: op.id,
      currentStatus: 'local',
      event: { kind: 'rejected', rejectionCode: 'RULE_VIOLATED', rejectionReason: 'x' },
    });
  }
  const asked: string[][] = [];
  const subjects: RejectedSubjectReaders = {
    repair_ticket: (_db, ids) => {
      asked.push([...ids]);
      return Promise.resolve(new Map([[NAMED, 'Servisan K7Q-0042']]));
    },
  };

  const reads = await readSyncStatusRows(db.db, subjects, await makerOf(ops[0]!.id));

  const byOp = new Map(reads.rejected.map((row) => [row.opId, row.subject]));
  expect(byOp.get(ops[0]!.id)).toBe('Servisan K7Q-0042');
  expect(byOp.get(ops[1]!.id)).toBeNull();
  // One read for every refused op of the type, not one per op.
  expect(asked).toHaveLength(1);
  expect(new Set(asked[0])).toEqual(new Set([NAMED, GONE]));
});

/** Two refused changes by the builder's user, as `markSyncResult` leaves them. */
async function refuseTwo(seed: number): Promise<{ userId: string; ids: string[] }> {
  const builder = new ChainBuilder(makeWorld(seed, noblePort), noblePort);
  builder.genesis();
  const ops = [NAMED, GONE].map((entityId) =>
    builder.append({
      type: 'repair.ticket_cancelled',
      entityType: 'repair_ticket',
      entityId,
      payload: { reason: 'x' },
    }),
  );
  for (const op of ops) {
    await insertOpLogRow(db.db, opRowOf(op), {
      syncStatus: 'local',
      syncedAt: null,
      arrivalSeq: null,
    });
    await markSyncResult(db.db as unknown as Parameters<typeof markSyncResult>[0], {
      id: op.id,
      currentStatus: 'local',
      event: { kind: 'rejected', rejectionCode: 'RULE_VIOLATED', rejectionReason: 'x' },
    });
  }
  return { userId: await makerOf(ops[0]!.id), ids: ops.map((op) => op.id) };
}

test('only the person whose change was refused is asked about it, and nobody while locked', async () => {
  const { userId, ids } = await refuseTwo(4402);

  expect(
    (await readSyncStatusRows(db.db, {}, userId)).rejected.map((row) => row.opId).sort(),
  ).toEqual([...ids].sort());
  expect((await readSyncStatusRows(db.db, {}, 'someone-else')).rejected).toEqual([]);
  expect((await readSyncStatusRows(db.db, {}, null)).rejected).toEqual([]);
});

test('a refusal marked handled stops asking, and only its maker can mark it', async () => {
  const { userId, ids } = await refuseTwo(4403);

  // A colleague's mark changes nothing.
  await markRejectionsHandled(db, 'someone-else', ids, 10);
  expect((await readSyncStatusRows(db.db, {}, userId)).rejected).toHaveLength(2);

  // Only the rows the person was shown: one handled, the other still listed.
  await markRejectionsHandled(db, userId, [ids[0]!], 10);
  expect((await readSyncStatusRows(db.db, {}, userId)).rejected.map((row) => row.opId)).toEqual([
    ids[1],
  ]);

  await markRejectionsHandled(db, userId, ids, 11);
  expect((await readSyncStatusRows(db.db, {}, userId)).rejected).toEqual([]);
  // The refusal itself stays on record.
  const rows = await db.db
    .selectFrom('operations')
    .select(['syncStatus', 'rejectionHandledAt'])
    .where('id', 'in', ids)
    .execute();
  expect(rows.map((row) => row.syncStatus)).toEqual(['rejected', 'rejected']);
  expect(new Set(rows.map((row) => row.rejectionHandledAt))).toEqual(new Set([10, 11]));
});

test('a servisan shows a refusal only to its maker, until they mark it checked', async () => {
  const { userId, ids } = await refuseTwo(4404);
  const statuses = (viewer: string) =>
    readEntitySyncStatuses(db.db, 'repair_ticket', [NAMED, GONE], viewer);

  expect(await statuses(userId)).toEqual({ [NAMED]: ['rejected'], [GONE]: ['rejected'] });
  // A colleague signed in here has nothing to redo: the servisan reads as sent.
  expect(await statuses('someone-else')).toEqual({});

  await markRejectionsHandled(db, userId, [ids[0]!], 10);
  expect(await statuses(userId)).toEqual({ [GONE]: ['rejected'] });
});
