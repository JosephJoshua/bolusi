// Permission-scoped sync on the device (owner decision 2026-10-31): the server filters each pull by
// the device's read set and says which set it used. The device must drop what it may no longer
// read, catch up on what it newly may, and keep its own ops and its watermarks sound throughout.
// Every assertion is about durable state: what is in the log, the records, the cursors.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PullResponse, SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import {
  countRows,
  makeDevice,
  makeSignedNoteOp,
  openSyncHarness,
  prngFor,
  seedDeviceRegistry,
  uuidV4,
  uuidV7,
  type SyncHarness,
  type TestDevice,
} from './_fixtures.js';
import {
  insertOpLogRow,
  readSyncState,
  runPullPhase,
  signedCoreJcsOf,
  writeSyncState,
  type ReadScopeRegistry,
} from '../../src/index.js';

const NOTES_READ = 'notes.read';

/** One op type, read with `notes.read`: enough to see a type leave and come back. */
const registry: ReadScopeRegistry = {
  types: () => ['notes.note_created'],
  readPermissionFor: (type) => (type === 'notes.note_created' ? NOTES_READ : undefined),
};

let harness: SyncHarness;
let other: TestDevice;
let own: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;
let prng: ReturnType<typeof prngFor>;

beforeEach(async () => {
  harness = await openSyncHarness();
  prng = prngFor(9031);
  other = makeDevice(prng, 3);
  own = makeDevice(prng, 4);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  await seedDeviceRegistry(
    harness.db,
    [other, own].map((device) => ({
      id: device.id,
      storeId,
      kind: 'member' as const,
      signingKeyPublic: device.publicKeyBase64,
      status: 'active' as const,
      revokedAt: null,
    })),
  );
});

afterEach(async () => {
  await harness.close();
});

function noteOps(device: TestDevice, count: number, from = 1): SignedOperation[] {
  return Array.from({ length: count }, (_, i) => {
    const at = 1_726_000_000_000 + (from + i) * 1000;
    return makeSignedNoteOp({
      device,
      seq: from + i,
      timestamp: at,
      tenantId,
      storeId,
      userId,
      entityId: uuidV7(prng, at),
      payload: { title: `t${String(from + i)}`, body: 'b' },
      prng,
    });
  });
}

function page(ops: SignedOperation[], nextCursor: number, readSet?: string[]): PullResponse {
  return {
    ops,
    nextCursor,
    hasMore: false,
    serverTime: 1_726_000_900_000,
    ...(readSet === undefined ? {} : { readSet }),
  };
}

function pull() {
  return runPullPhase({
    db: harness.db,
    transaction: harness.transaction,
    transport: harness.transport,
    surface: harness.surface,
    crypto: noblePort,
    clock: harness.clock,
    applyPulledOp: (op) => harness.engine.applyPulledOp(op),
    readScope: {
      registry,
      refold: (record) => harness.engine.refoldEntityOf(record),
      catchUpWatermarks: () => harness.engine.catchUpPulledWatermarks(),
    },
  });
}

/** This device's own note, already pushed: no arrival number, like every own op. */
async function ownSyncedNote(): Promise<void> {
  const [op] = noteOps(own, 1);
  await insertOpLogRow(
    harness.db,
    { op: op!, signedCoreJcs: signedCoreJcsOf(op!, noblePort) },
    { syncStatus: 'synced', syncedAt: 1, arrivalSeq: null },
  );
  await harness.engine.applyAppendedOp(op!);
}

async function notesFrom(deviceId: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS "n" FROM operations WHERE device_id = ${deviceId}
  `.execute(harness.db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('a shrunk read set drops what the device may no longer read', () => {
  it('removes the pulled ops and their records, and keeps the device own ones', async () => {
    harness.transport.scriptPull(page(noteOps(other, 3), 30, [NOTES_READ]));
    await pull();
    await ownSyncedNote();
    expect(await countRows(harness.db, 'notes')).toBe(4);

    harness.transport.scriptPull(page([], 30, []));
    await pull();

    expect(await notesFrom(other.id)).toBe(0);
    expect(await notesFrom(own.id)).toBe(1);
    // The records follow the log: only the device's own note is left.
    expect(await countRows(harness.db, 'notes')).toBe(1);
    const state = await readSyncState(harness.db);
    expect(state.readSet).toEqual([]);
    expect(state.backfill).toBeNull();
    expect(state.cursor).toBe(30);
  });

  it('leaves the watermark free to move after the hole the removal left', async () => {
    harness.transport.scriptPull(page(noteOps(other, 3), 30, [NOTES_READ]));
    await pull();
    harness.transport.scriptPull(page([], 30, []));
    await pull();
    // The permission comes back and new notes arrive by the normal pull.
    harness.transport.scriptPull(page(noteOps(other, 2, 4), 40, [NOTES_READ]));
    await pull();

    const watermark = (await harness.engine.readWatermarks('notes')).appliedServerSeq;
    const newest = await sql<{ m: number }>`
      SELECT MAX(arrival_seq) AS "m" FROM operations
    `.execute(harness.db);
    expect(watermark).toBe(Number(newest.rows[0]?.m));
  });

  it('drops on the first scoped pull of a device upgraded from an unscoped server', async () => {
    // An older server sent everything; the device has no read set yet.
    harness.transport.scriptPull(page(noteOps(other, 2), 20));
    await pull();
    expect((await readSyncState(harness.db)).readSet).toBeNull();

    harness.transport.scriptPull(page([], 20, []));
    await pull();
    expect(await notesFrom(other.id)).toBe(0);
  });
});

describe('a grown read set catches up on older ops', () => {
  it('pulls the skipped ops, up to where the normal pull was, then stops', async () => {
    harness.transport.scriptPull(page([], 50, []));
    await pull();

    const older = noteOps(other, 2);
    const newer = noteOps(other, 1, 3);
    harness.transport.scriptPull(page(newer, 60, [NOTES_READ]), page(older, 50, [NOTES_READ]));
    await pull();

    const catchUp = harness.transport.pulls.at(-1);
    expect(catchUp?.backfill).toEqual({ reads: [NOTES_READ], through: 50 });
    expect(catchUp?.cursor).toBe(0);
    expect(await countRows(harness.db, 'notes')).toBe(3);
    const state = await readSyncState(harness.db);
    expect(state.backfill).toBeNull();
    // The catch-up never moves the normal cursor.
    expect(state.cursor).toBe(60);
    expect(state.readSet).toEqual([NOTES_READ]);
  });

  it('resumes an interrupted catch-up from its own cursor', async () => {
    await writeSyncState(harness.db, {
      cursor: 60,
      readSet: [NOTES_READ],
      backfill: { reads: [NOTES_READ], through: 50, cursor: 25 },
    });
    harness.transport.scriptPull(
      page([], 60, [NOTES_READ]),
      page(noteOps(other, 1), 50, [NOTES_READ]),
    );
    await pull();

    expect(harness.transport.pulls.at(-1)).toMatchObject({
      cursor: 25,
      backfill: { reads: [NOTES_READ], through: 50 },
    });
    expect((await readSyncState(harness.db)).backfill).toBeNull();
  });

  it('abandons a catch-up whose permission was taken away again', async () => {
    await writeSyncState(harness.db, {
      cursor: 60,
      readSet: [NOTES_READ],
      backfill: { reads: [NOTES_READ], through: 50, cursor: 25 },
    });
    harness.transport.scriptPull(page([], 60, []));
    await pull();

    expect(harness.transport.pulls).toHaveLength(1);
    expect((await readSyncState(harness.db)).backfill).toBeNull();
  });

  it('a new device starts with the set it is given and nothing to catch up on', async () => {
    harness.transport.scriptPull(page(noteOps(other, 1), 10, [NOTES_READ]));
    await pull();

    expect(harness.transport.pulls).toHaveLength(1);
    const state = await readSyncState(harness.db);
    expect(state.readSet).toEqual([NOTES_READ]);
    expect(state.backfill).toBeNull();
  });
});
