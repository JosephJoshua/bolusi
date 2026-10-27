// The refused-changes list names what each change was about ("Servisan K7Q-0042") through the
// module's subject reader, read against a REAL client DB with real migrations.
import { insertOpLogRow, markSyncResult } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { ChainBuilder, makeWorld, noblePort, nodeColumnAead, opRowOf } from '@bolusi/test-support';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';

import { readSyncStatusRows, type RejectedSubjectReaders } from './sync-status-reads.js';

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

  const reads = await readSyncStatusRows(db.db, subjects);

  const byOp = new Map(reads.rejected.map((row) => [row.opId, row.subject]));
  expect(byOp.get(ops[0]!.id)).toBe('Servisan K7Q-0042');
  expect(byOp.get(ops[1]!.id)).toBeNull();
  // One read for every refused op of the type, not one per op.
  expect(asked).toHaveLength(1);
  expect(new Set(asked[0])).toEqual(new Set([NAMED, GONE]));
});
