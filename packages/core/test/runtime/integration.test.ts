// L2 — the full 04 §5.1 sequence against a REAL database (testing-guide §2.1 L2).
//
// The unit suites run the append path against an in-memory store that models the operations
// table's invariants. This one runs it against better-sqlite3 `:memory:` with the real client
// migrations, the real Kysely dialect, and task 08's REAL projection engine — so `append and
// project are one transaction` is asserted against an engine that actually does transactions,
// not against a fake that agrees with me.
//
// The end of the chain is the point: `execute(createNote)` → a row a QUERY can read. Everything
// between (parse, permission, handler, envelope completion, signing, chaining, insert, apply) is
// production code (T-7).
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';

import {
  assemblePermissionRegistry,
  CommandRuntime,
  createProjectionEngine,
  createUuidV7Generator,
  PermissionEvaluator,
  ProjectionRegistry,
  type ClockPort,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type OpAppendStore,
  type OpAppendTx,
  type SigningKeyPort,
} from '../../src/index.js';

import {
  MAIN_OWNER_IDS,
  ROLE_MAIN_OWNER,
  ROLE_STAFF,
  STAFF_IDS,
  V0_MODULES,
  role,
} from '../authz/_fixtures.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';
import { notesModule } from '../projection/notes-fixture.js';
import {
  makeCommandSpy,
  makeFakeClock,
  EventLog,
  expectDomainError,
  fixtureOperations,
} from './_fixtures.js';

/**
 * The op store over the REAL driver: one driver-level transaction per command, shared with the
 * Kysely handle the projection engine writes through (10-db §9) — which is exactly what makes
 * steps 5–6 atomic (04 §5.1). This is the shape `@bolusi/db-client` binds in production.
 */
class SqliteOpStore implements OpAppendStore {
  constructor(
    private readonly driver: DbDriver,
    private readonly db: Kysely<ClientDatabase>,
  ) {}

  async transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T> {
    await this.driver.begin();
    try {
      const result = await fn({
        readChainHead: async (deviceId) => {
          const rows = await sql<{ seq: number; hash: string }>`
            SELECT seq, hash FROM operations WHERE device_id = ${deviceId}
            ORDER BY seq DESC LIMIT 1
          `.execute(this.db);
          const head = rows.rows[0];
          return head === undefined ? null : { seq: head.seq, hash: head.hash };
        },
        hasOp: async (id) => {
          const rows = await sql<{ one: number }>`
            SELECT 1 AS one FROM operations WHERE id = ${id} LIMIT 1
          `.execute(this.db);
          return rows.rows.length > 0;
        },
        insertOp: async ({ op, signedCoreJcs }) => {
          await this.db
            .insertInto('operations')
            .values({
              id: op.id,
              tenantId: op.tenantId,
              storeId: op.storeId,
              userId: op.userId,
              deviceId: op.deviceId,
              seq: op.seq,
              type: op.type,
              entityType: op.entityType,
              entityId: op.entityId,
              schemaVersion: op.schemaVersion,
              payload: JSON.stringify(op.payload),
              timestampMs: op.timestamp,
              location: op.location === null ? null : JSON.stringify(op.location),
              source: op.source,
              agentInitiated: op.agentInitiated ? 1 : 0,
              agentConversationId: op.agentConversationId,
              previousHash: op.previousHash,
              hash: op.hash,
              signature: op.signature,
              signedCoreJcs,
              // Born local (03 §3 birth state) — sync is task 15.
              syncStatus: 'local',
              serverSeq: null,
              syncedAt: null,
            })
            .execute();
        },
      });
      await this.driver.commit();
      return result;
    } catch (error) {
      await this.driver.rollback();
      throw error;
    }
  }
}

interface Harness {
  readonly runtime: CommandRuntime;
  readonly db: Kysely<ClientDatabase>;
  readonly log: EventLog;
  readonly ownerId: string;
  readonly staffId: string;
  readonly deviceId: string;
  readonly storeId: string;
  close(): Promise<void>;
}

const open = async (seed: number, faultyApplier = false): Promise<Harness> => {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const registry = new ProjectionRegistry<ClientDatabase>();
  registry.register(notesModule);
  const engine = createProjectionEngine(db, registry);

  const prng = mulberry32(seed);
  const clock = makeFakeClock(1_726_000_000_000);
  const idGen = createUuidV7Generator({
    now: () => 1_726_000_000_000,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = idGen();
  const storeId = idGen();
  const ownerId = idGen();
  const staffId = idGen();
  const deviceId = idGen();
  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const newId = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => prngBytes(prng, n),
  });

  const snapshot: DirectorySnapshot = {
    tenantId,
    users: new Map([
      [ownerId, { status: 'active' }],
      [staffId, { status: 'active' }],
    ]),
    roles: new Map<string, DirectoryRole>([
      [ROLE_MAIN_OWNER, role('tenant', MAIN_OWNER_IDS)],
      [ROLE_STAFF, role('store', STAFF_IDS)],
    ]),
    grantsByUser: new Map<string, readonly DirectoryGrant[]>([
      [ownerId, [{ roleId: ROLE_MAIN_OWNER, storeId: null }]],
      // Deliberately granted in ANOTHER store: staff is denied here (02 §5.2 scope matching).
      [staffId, [{ roleId: ROLE_STAFF, storeId: idGen() }]],
    ]),
  };
  const evaluator = new PermissionEvaluator(assemblePermissionRegistry(V0_MODULES), {
    load: () => Promise.resolve(snapshot),
  });
  await evaluator.prime();

  const log = new EventLog();
  const clockPort: ClockPort = { now: () => clock.now() };
  const signingKey: SigningKeyPort = { getSigningKey: () => keypair.secretKey };

  const runtime = new CommandRuntime({
    device: { tenantId, storeId, deviceId },
    evaluator,
    operations: fixtureOperations,
    store: new SqliteOpStore(driver, db),
    crypto: noblePort,
    clock: clockPort,
    idSource: newId,
    location: { getBestFix: () => null },
    signingKey,
    queryExecutor: { execute: () => Promise.resolve(undefined as never) },
    applyProjection: async (op) => {
      if (faultyApplier && op.type === 'notes.note_created') throw new Error('applier exploded');
      await engine.applyAppendedOp(op);
    },
    syncScheduler: { schedule: () => log.record('schedule-sync') },
  });

  // Genesis first (05 §9.5) — the device must be enrolled before it can command.
  await runtime.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: { enrolledDeviceId: deviceId },
    userId: ownerId,
  });
  log.clear();

  return {
    runtime,
    db,
    log,
    ownerId,
    staffId,
    deviceId,
    storeId,
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
};

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the full sequence against better-sqlite3 :memory: (L2)', () => {
  it('createNote → parse → permission → handler → append → project → a query-visible row', async () => {
    harness = await open(1);
    const command = makeCommandSpy(harness.log);

    const outcome = await harness.runtime.execute(
      command,
      { title: 'Stok kopi', body: 'Sisa 4 karung' },
      harness.runtime.createContext(harness.ownerId),
    );

    // The op landed in the real op log...
    const ops = await harness.db
      .selectFrom('operations')
      .selectAll()
      .where('type', '=', 'notes.note_created')
      .execute();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.seq, 'chained after the genesis op').toBe(2);
    expect(ops[0]!.syncStatus).toBe('local');

    // ...and task 08's engine projected it into a row a query can read. This is the end of §5.1.
    const notes = await harness.db.selectFrom('notes').selectAll().execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Stok kopi');
    expect(notes[0]!.body).toBe('Sisa 4 karung');
    expect(notes[0]!.id).toBe(outcome.result?.noteId);
    expect(notes[0]!.createdBy).toBe(harness.ownerId);
    expect(notes[0]!.storeId).toBe(harness.storeId);
    expect(harness.log.count('schedule-sync')).toBe(1);
  });

  it('a multi-op command projects every op under one timestamp', async () => {
    harness = await open(2);
    const command = makeCommandSpy(harness.log, { extraOps: 1 });

    await harness.runtime.execute(
      command,
      { title: 'Kopi', body: 'awal' },
      harness.runtime.createContext(harness.ownerId),
    );

    const notes = await harness.db.selectFrom('notes').selectAll().execute();
    expect(notes).toHaveLength(1);
    // The create AND the edit both applied — editCount proves the edit was not lost.
    expect(notes[0]!.editCount).toBe(1);
    expect(notes[0]!.body).toBe('awal-0');

    const rows = await harness.db
      .selectFrom('operations')
      .select(['timestampMs'])
      .where('type', 'in', ['notes.note_created', 'notes.note_body_edited'])
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.timestampMs)).size, 'one stamp per command (04 §5.2)').toBe(1);
  });

  it('a denied command writes NOTHING but the denial op — against the real DB', async () => {
    harness = await open(3);
    const command = makeCommandSpy(harness.log, { name: 'createNote', permission: 'notes.create' });

    // `staff` holds notes.create, but their grant is scoped to a DIFFERENT store — so in this
    // device's store the check denies (02 §5.2 step 4).
    const error = await harness.runtime
      .execute(command, { title: 't', body: 'b' }, harness.runtime.createContext(harness.staffId))
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(await harness.db.selectFrom('notes').selectAll().execute()).toEqual([]);

    const denials = await harness.db
      .selectFrom('operations')
      .selectAll()
      .where('type', '=', 'auth.permission_denied')
      .execute();
    expect(denials, 'the denial op is durable in the real log (02 §7)').toHaveLength(1);
    expect(denials[0]!.userId).toBe(harness.staffId);
  });

  it('an applier that throws rolls back the REAL transaction — no op row, no note row', async () => {
    harness = await open(4, true);
    const command = makeCommandSpy(harness.log);

    await expect(
      harness.runtime.execute(
        command,
        { title: 't', body: 'b' },
        harness.runtime.createContext(harness.ownerId),
      ),
    ).rejects.toThrow('applier exploded');

    // Real SQLite rollback: neither the op nor the projection row survives, and the chain head is
    // still the genesis op — so the next command reuses seq 2 and the device never gaps.
    expect(await harness.db.selectFrom('notes').selectAll().execute()).toEqual([]);
    const ops = await harness.db.selectFrom('operations').selectAll().execute();
    expect(ops, 'only the genesis op remains').toHaveLength(1);
    expect(ops[0]!.type).toBe('auth.device_enrolled');
  });

  it('POSITIVE CONTROL — the same harness commits when the applier works (T-14b)', async () => {
    harness = await open(5, false);
    const command = makeCommandSpy(harness.log);

    await harness.runtime.execute(
      command,
      { title: 'ok', body: 'b' },
      harness.runtime.createContext(harness.ownerId),
    );

    expect(await harness.db.selectFrom('notes').selectAll().execute()).toHaveLength(1);
  });
});
