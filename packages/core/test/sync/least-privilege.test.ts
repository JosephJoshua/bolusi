// Least-privilege sync on the device (owner decisions 2026-10-31 and 2026-11-01). A device holds on
// disk only what its read set covers. Its own changes of other types stay in its log as chain links,
// their text cleared once sent; a person who may read more gets the rest in a person store, held in
// memory (SQLite temp tables) for their session, through the same pull and the same fold.
// Every assertion reads durable state, or the database file itself.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { PullRequest, PullResponse, SignedOperation } from '@bolusi/schemas';
import { openFileDriver } from '@bolusi/sqlite-test-driver';
import { noblePort } from '@bolusi/test-support';

import {
  makeDevice,
  makeSignedNoteOp,
  prngFor,
  seedDeviceRegistry,
  uuidV4,
  uuidV7,
  type TestDevice,
} from './_fixtures.js';
import { notesModule } from '../projection/notes-fixture.js';
import {
  clearHeldText,
  createProjectionEngine,
  dropPersonStoreTables,
  markSyncResult,
  DeviceReads,
  insertOpLogRow,
  InvalidationBus,
  PersonStore,
  projectionTableReads,
  ProjectionRegistry,
  readSyncState,
  runPullPhase,
  signedCoreJcsOf,
  type ProjectionEngine,
  type ReadScopeRegistry,
} from '../../src/index.js';
import { FakeClock, FakeSurface, FakeTransport } from './_fixtures.js';

const NOTES_READ = 'notes.read';
const SECRET = 'harga-modal-rahasia';

const scope: ReadScopeRegistry & {
  entityTypeFor: (type: string) => string | undefined;
} = {
  types: () => ['notes.note_created'],
  readPermissionFor: (type) => (type.startsWith('notes.') ? NOTES_READ : undefined),
  entityTypeFor: (type) => (type.startsWith('notes.') ? 'note' : undefined),
};

let dir: string;
let file: string;
let db: Kysely<ClientDatabase>;
let driver: ReturnType<typeof openFileDriver>;
let projections: ProjectionRegistry<ClientDatabase>;
let invalidation: InvalidationBus;
let reads: DeviceReads;
let engine: ProjectionEngine<ClientDatabase>;
let transport: FakeTransport;
let clock: FakeClock;
let prng: ReturnType<typeof prngFor>;
let other: TestDevice;
let own: TestDevice;
let tenantId: string;
let storeId: string;
let userId: string;

const transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
  await driver.begin();
  try {
    const result = await fn();
    await driver.commit();
    return result;
  } catch (error) {
    await driver.rollback();
    throw error;
  }
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'least-privilege-'));
  file = join(dir, 'device.db');
  driver = openFileDriver(file);
  await runClientMigrations(driver, { now: () => 1 });
  await driver.execute('PRAGMA temp_store = MEMORY');
  db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  projections = new ProjectionRegistry<ClientDatabase>();
  projections.register(notesModule);
  invalidation = new InvalidationBus();
  reads = new DeviceReads(scope, null);
  engine = createProjectionEngine(db, projections, { invalidation, folds: reads.folds });
  transport = new FakeTransport();
  clock = new FakeClock();
  prng = prngFor(9077);
  other = makeDevice(prng, 5);
  own = makeDevice(prng, 6);
  tenantId = uuidV4(prng);
  storeId = uuidV4(prng);
  userId = uuidV4(prng);
  await seedDeviceRegistry(
    db,
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
  await db.destroy().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

let nextAt = 1_726_000_000_000;
function note(device: TestDevice, seq: number, title = SECRET): SignedOperation {
  nextAt += 1000;
  return makeSignedNoteOp({
    device,
    seq,
    timestamp: nextAt,
    tenantId,
    storeId,
    userId,
    entityId: uuidV7(prng, nextAt),
    payload: { title, body: 'b' },
    prng,
  });
}

function page(ops: SignedOperation[], nextCursor: number, readSet: string[]): PullResponse {
  return { ops, nextCursor, hasMore: false, serverTime: 1_726_000_900_000, readSet };
}

function pull(
  beforeGrow?: (added: readonly string[]) => Promise<void>,
  applyPulledOp: (op: SignedOperation) => Promise<unknown> = (op) => engine.applyPulledOp(op),
) {
  return runPullPhase({
    db,
    transaction,
    transport,
    surface: new FakeSurface(),
    crypto: noblePort,
    clock,
    applyPulledOp,
    readScope: {
      registry: scope,
      refold: (record) => engine.refoldEntityOf(record),
      catchUpWatermarks: () => engine.catchUpPulledWatermarks(),
      deviceReads: reads,
      ...(beforeGrow === undefined ? {} : { beforeGrow }),
    },
  });
}

/** One of this device's own notes, appended and folded as the append path does. */
async function ownNote(seq: number, status: 'local' | 'synced'): Promise<SignedOperation> {
  const op = note(own, seq);
  await transaction(async () => {
    await insertOpLogRow(
      db,
      { op, signedCoreJcs: signedCoreJcsOf(op, noblePort) },
      { syncStatus: status, syncedAt: status === 'synced' ? 1 : null, arrivalSeq: null },
    );
    await engine.applyAppendedOp(op);
  });
  return op;
}

async function count(query: string): Promise<number> {
  const result = await sql<{ n: number }>`${sql.raw(query)}`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

const clearedOwn = () =>
  count(
    `SELECT COUNT(*) AS n FROM main.operations WHERE device_id = '${own.id}' AND signed_core_jcs = ''`,
  );

function store(): Promise<PersonStore<ClientDatabase>> {
  return PersonStore.open(
    { db, transaction, crypto: noblePort, clock, projections, operations: scope, invalidation },
    [NOTES_READ],
  );
}

const personPort = (...replies: PullResponse[]) => {
  const requests: PullRequest[] = [];
  return {
    requests,
    pull: (request: PullRequest) => {
      requests.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('no scripted person pull');
      return Promise.resolve(reply);
    },
  };
};

describe('every projection table is read with one permission', () => {
  it('derives each table’s read from the types folding into it', () => {
    expect(projectionTableReads(projections, scope)).toEqual(new Map([['notes', NOTES_READ]]));
  });

  it('refuses a table folded from types read with different permissions', () => {
    const mixed = {
      ...scope,
      readPermissionFor: (type: string) =>
        type === 'notes.note_created' ? NOTES_READ : 'notes.other',
    };
    expect(() => projectionTableReads(projections, mixed)).toThrow(/different permissions/);
  });
});

describe('a device that may no longer read a type', () => {
  it('drops pulled ops, clears its own sent changes’ text and records, keeps unsent ones to send', async () => {
    transport.scriptPull(page([note(other, 1)], 10, [NOTES_READ]));
    await pull();
    await ownNote(1, 'synced');
    const unsent = await ownNote(2, 'local');
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(3);

    transport.scriptPull(page([], 10, []));
    await pull();

    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM operations WHERE device_id = '${other.id}'`),
    ).toBe(0);
    // Both own changes stay as chain links; only the sent one loses its text.
    expect(await count(`SELECT COUNT(*) AS n FROM operations WHERE device_id = '${own.id}'`)).toBe(
      2,
    );
    expect(await clearedOwn()).toBe(1);
    const kept = await sql<{ text: string }>`
      SELECT signed_core_jcs AS "text" FROM operations WHERE id = ${unsent.id}
    `.execute(db);
    expect(kept.rows[0]?.text).not.toBe('');
  });

  it('gets its own cleared change back from the server when it may read the type again', async () => {
    transport.scriptPull(page([], 10, [NOTES_READ]));
    await pull();
    const sent = await ownNote(1, 'synced');
    transport.scriptPull(page([], 10, []));
    await pull();
    expect(await clearedOwn()).toBe(1);

    // Granted again: the catch-up brings the device's own change, which folds once more.
    transport.scriptPull(page([], 20, [NOTES_READ]), page([sent], 10, [NOTES_READ]));
    await pull();
    expect(await clearedOwn()).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(1);
    expect((await readSyncState(db)).backfill).toBeNull();
  });

  it('never folds a held type it appends, and clears its text once sent', async () => {
    reads.set([]);
    const op = await ownNote(1, 'local');
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
    await clearHeldText(db, reads.heldTypes());
    expect(await clearedOwn()).toBe(0);
    await markSyncResult(db as never, {
      id: op.id,
      currentStatus: 'local',
      event: { kind: 'accepted', syncedAt: 2 },
    });
    await clearHeldText(db, reads.heldTypes());
    expect(await clearedOwn()).toBe(1);
  });
});

describe('a device that may read a type again', () => {
  it('folds its own changes of it that never left the log, sent or not', async () => {
    transport.scriptPull(page([], 10, []));
    await pull();
    await ownNote(1, 'local');
    await ownNote(2, 'synced');
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);

    transport.scriptPull(page([], 20, [NOTES_READ]), page([], 10, [NOTES_READ]));
    await pull();
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(2);
  });

  it('closes a signed-in person’s store first, so what it folds lands on its own tables', async () => {
    transport.scriptPull(page([], 10, []));
    await pull();
    const person = await store();
    await person.pull(personPort(page([note(other, 1)], 40, [NOTES_READ])));
    expect(await count('SELECT COUNT(*) AS n FROM temp.notes')).toBe(1);

    transport.scriptPull(
      page([note(other, 2)], 20, [NOTES_READ]),
      page([note(other, 1)], 10, [NOTES_READ]),
    );
    await pull((added) =>
      added.includes(NOTES_READ) ? person.close({ withinTransaction: true }) : Promise.resolve(),
    );

    expect(await count("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'table'")).toBe(
      0,
    );
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(2);
  });
});

describe('a device pull that grows the read set and then fails', () => {
  it('drops the person’s tables again on the retry, so the device’s rows still land on disk', async () => {
    transport.scriptPull(page([], 10, []));
    await pull();
    const person = await store();
    await person.pull(personPort(page([note(other, 1)], 40, [NOTES_READ])));

    transport.scriptPull(page([note(other, 2)], 20, [NOTES_READ]));
    await expect(
      pull(
        () => dropPersonStoreTables(db).then(() => undefined),
        () => Promise.reject(new Error('applier failed')),
      ),
    ).rejects.toThrow();
    // The rollback brought the person's tables back with it.
    expect(
      await count("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'table'"),
    ).toBeGreaterThan(0);

    transport.scriptPull(
      page([note(other, 2)], 20, [NOTES_READ]),
      page([note(other, 1)], 10, [NOTES_READ]),
    );
    await pull(() => dropPersonStoreTables(db).then(() => undefined));
    expect(await count("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'table'")).toBe(
      0,
    );
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(2);
  });

  it('a store opening after the device grew leaves the device’s reads to the device', async () => {
    const person = await PersonStore.open(
      {
        db,
        transaction,
        crypto: noblePort,
        clock,
        projections,
        operations: scope,
        invalidation,
        deviceHolds: (read) => read === NOTES_READ,
      },
      [NOTES_READ],
    );
    expect(person.holds).toBe(false);
    expect(await count("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'table'")).toBe(
      0,
    );
  });
});

/** Everything the database file and its write-ahead log hold, as text. */
async function fileText(): Promise<string> {
  await driver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  return [file, `${file}-wal`]
    .map((path) => {
      try {
        return readFileSync(path).toString('latin1');
      } catch {
        return '';
      }
    })
    .join('');
}

describe('the file check itself', () => {
  it('finds a note’s title the device folds into its own tables', async () => {
    transport.scriptPull(page([note(other, 1)], 10, [NOTES_READ]));
    await pull();
    expect(await fileText()).toContain(SECRET);
  });
});

describe('a person store holds a signed-in person’s extra in memory only', () => {
  beforeEach(() => {
    reads.set([]);
  });

  it('pulls and folds the extra under the device’s own table names, and none of it reaches the file', async () => {
    const person = await store();
    const port = personPort(page([note(other, 1), note(other, 2)], 40, [NOTES_READ]));
    expect(await person.pull(port)).toEqual({ kind: 'current' });
    expect(port.requests[0]).toMatchObject({ cursor: 0, person: true });

    // Queries read the person's rows by the usual name; the device's own table stays empty.
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM main.operations')).toBe(0);

    expect(await fileText()).not.toContain(SECRET);
  });

  it('shows the person’s own changes on this device as it opens, sent or not', async () => {
    await ownNote(1, 'local');
    await ownNote(2, 'synced');
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
    await store();
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
  });

  it('carries on from its cursor, and asks to start over when the person’s extra changes', async () => {
    const person = await store();
    await person.pull(personPort(page([note(other, 1)], 40, [NOTES_READ])));
    const next = personPort(page([], 40, [NOTES_READ]), page([], 40, []));
    expect(await person.pull(next)).toEqual({ kind: 'current' });
    expect(next.requests[0]?.cursor).toBe(40);
    expect(await person.pull(next)).toMatchObject({ kind: 'reopen' });
  });

  it('folds the person’s own new change at once, while the device keeps only the chain link', async () => {
    const person = await store();
    const op = note(own, 1);
    await transaction(async () => {
      await insertOpLogRow(
        db,
        { op, signedCoreJcs: signedCoreJcsOf(op, noblePort) },
        { syncStatus: 'local', syncedAt: null, arrivalSeq: null },
      );
      await engine.applyAppendedOp(op);
      await person.applyAppended(op);
    });
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);

    // Refused by the server: it comes back out of the person's view too.
    await person.refuse(op);
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(0);
  });

  it('closing drops everything, and a pull that lands after it writes nothing anywhere', async () => {
    const person = await store();
    await person.pull(personPort(page([note(other, 1)], 40, [NOTES_READ])));
    const refreshed: string[][] = [];
    invalidation.subscribe((tables) => refreshed.push([...tables]));
    await person.close();

    expect(refreshed).toContainEqual(['notes']);
    expect(await count("SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'table'")).toBe(
      0,
    );
    expect(await count('SELECT COUNT(*) AS n FROM notes')).toBe(0);
    expect(await person.pull(personPort(page([note(other, 2)], 50, [NOTES_READ])))).toEqual({
      kind: 'current',
    });
    expect(await count('SELECT COUNT(*) AS n FROM main.notes')).toBe(0);
  });

  it('an empty extra holds nothing and pulls nothing', async () => {
    const person = await PersonStore.open(
      { db, transaction, crypto: noblePort, clock, projections, operations: scope, invalidation },
      [],
    );
    expect(person.holds).toBe(false);
    const port = personPort();
    expect(await person.pull(port)).toEqual({ kind: 'current' });
    expect(port.requests).toHaveLength(0);
  });
});
