// L2 harness for the module contract (testing-guide §2.1 L2): the fixture module registered into
// REAL runtimes over a REAL SQLite database.
//
// T-7 — everything real except the I/O. Real `defineModule`, real `registerModules`, real
// `PermissionEvaluator` over a real assembled registry, real `CommandRuntime`, real `QueryRuntime`,
// real projection engine, real op append with real noble crypto and real signatures, real
// better-sqlite3 `:memory:` behind the shim dialect (§2.3). Faked: the clock, the id source, the
// location port and the sync scheduler — the I/O boundary, and nothing else.
//
// A mocked evaluator or a stubbed query executor would make every permission and gating assertion
// in this suite a test of the mock.
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { Location, SignedOperation } from '@bolusi/schemas';
import {
  makeFixtureModuleManifest,
  mulberry32,
  noblePort,
  randomBytes as prngBytes,
  type FixtureDatabase,
  type Prng,
} from '@bolusi/test-support';

import {
  createModuleRuntime,
  createProjectionEngine,
  createUuidV7Generator,
  decodeCursor,
  defineModule,
  encodeCursor,
  PermissionEvaluator,
  ProjectionRegistry,
  registerModules,
  type AnyModuleDefinition,
  type CommandRuntime,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type IdSource,
  type ModuleProjectionManifest,
  type ModuleRegistry,
  type OpAppendStore,
  type OpAppendTx,
  type OpRow,
  type QueryRuntime,
} from '../../src/index.js';
// ONE fixture set, not a second copy (CLAUDE.md §2.8). `DirectoryRole`'s real shape is
// `{ scopeType, permissionIdsJson }` — the permission ids ride as RAW JSON so a corrupt row denies
// only the evaluations that read it (authz/directory.ts). A local re-implementation of this helper
// got that wrong and the `as unknown as DirectoryRole` cast it needed silently hid it: every role
// loaded with `permissionIdsJson: undefined`, so every user held nothing and the whole suite failed
// closed. Reusing the real builder is what stops a fixture from quietly disagreeing with the type.
import { role } from '../authz/_fixtures.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

/** The fixture module's tables live alongside the client schema in one database. */
export type HarnessDatabase = ClientDatabase & FixtureDatabase;

/**
 * The fixture module, defined against THIS artifact's `defineModule` + cursor codec.
 *
 * `@bolusi/test-support` exports the MANIFEST and takes the codec as an argument (see
 * fixture-module.ts): it imports `@bolusi/core` for types only, so nothing here crosses the
 * src/dist boundary. `defineModule` below is `src`'s, which is the copy under test.
 */
export function defineFixtureModule(): AnyModuleDefinition<HarnessDatabase> {
  const manifest = makeFixtureModuleManifest({ encodeCursor, decodeCursor });
  return defineModule<FixtureDatabase, typeof manifest>(
    manifest,
  ) as unknown as AnyModuleDefinition<HarnessDatabase>;
}

/** Roles, so the directory can express "reads items" vs "reads items AND their secrets". */
export const ROLE_ADMIN = 'role-fixture-admin';
export const ROLE_READER = 'role-fixture-reader';
export const ROLE_SECRET_READER = 'role-fixture-secret-reader';

export interface ModuleHarness {
  readonly db: Kysely<HarnessDatabase>;
  readonly registry: ModuleRegistry<HarnessDatabase>;
  readonly module: AnyModuleDefinition<HarnessDatabase>;
  readonly commands: CommandRuntime;
  readonly queries: QueryRuntime<HarnessDatabase>;
  readonly evaluator: PermissionEvaluator;
  readonly newId: IdSource;
  readonly prng: Prng;
  readonly tenantId: string;
  readonly storeId: string;
  /** Holds fixture.create + fixture.read + fixture.read_secret (tenant-wide). */
  readonly adminId: string;
  /** Holds fixture.read ONLY — the unauthorized caller for the gating test. */
  readonly readerId: string;
  /** Holds fixture.read + fixture.read_secret — the POSITIVE control (T-14b). */
  readonly secretReaderId: string;
  /** Active, holds nothing — the query-denial case. */
  readonly zeroGrantId: string;
  readonly deviceId: string;
  /** Ops appended so far, in order — for asserting the round-trip's op. */
  readonly appended: SignedOperation[];
  advanceClock(ms: number): void;
  close(): Promise<void>;
}

/** An op store over the real SQLite `operations` table, applying projections in-transaction. */
class SqliteOpStore implements OpAppendStore {
  constructor(
    private readonly driver: {
      begin(): Promise<void>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
    },
    private readonly db: Kysely<HarnessDatabase>,
  ) {}

  async transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T> {
    await this.driver.begin();
    try {
      const result = await fn({
        readChainHead: async (deviceId: string) => {
          const rows = await sql<{ seq: number; hash: string }>`
            SELECT seq, hash FROM operations WHERE device_id = ${deviceId}
            ORDER BY seq DESC LIMIT 1
          `.execute(this.db);
          const head = rows.rows[0];
          return head === undefined ? null : { seq: head.seq, hash: head.hash };
        },
        hasOp: async (id: string) => {
          const rows = await sql<{ one: number }>`
            SELECT 1 AS one FROM operations WHERE id = ${id} LIMIT 1
          `.execute(this.db);
          return rows.rows.length > 0;
        },
        insertOp: async (row: OpRow) => {
          await this.db
            .insertInto('operations')
            .values({
              id: row.op.id,
              tenantId: row.op.tenantId,
              storeId: row.op.storeId,
              userId: row.op.userId,
              deviceId: row.op.deviceId,
              seq: row.op.seq,
              type: row.op.type,
              entityType: row.op.entityType,
              entityId: row.op.entityId,
              schemaVersion: row.op.schemaVersion,
              payload: JSON.stringify(row.op.payload),
              timestampMs: row.op.timestamp,
              location: row.op.location === null ? null : JSON.stringify(row.op.location),
              source: row.op.source,
              agentInitiated: row.op.agentInitiated ? 1 : 0,
              agentConversationId: row.op.agentConversationId,
              previousHash: row.op.previousHash,
              hash: row.op.hash,
              signature: row.op.signature,
              signedCoreJcs: row.signedCoreJcs,
              syncStatus: 'local',
              arrivalSeq: null,
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

/** Build a fully-seeded L2 harness. Two calls with the same seed reproduce bit-for-bit (T-6). */
export async function openModuleHarness(seed: number): Promise<ModuleHarness> {
  const startMs = 1_726_000_000_000;
  let nowMs = startMs;
  const prng = mulberry32(seed);

  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<HarnessDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const module = defineFixtureModule();
  // The fixture's own DDL (04 §4.4) — its table is not part of the client schema.
  for (const migration of module.projections.migrations ?? []) {
    await migration.up(db);
  }

  // Stable identities, minted before the clock moves. UUIDs because `zSignedCore` types them so.
  const identityGen = createUuidV7Generator({
    now: () => startMs,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = identityGen();
  const storeId = identityGen();
  const adminId = identityGen();
  const readerId = identityGen();
  const secretReaderId = identityGen();
  const zeroGrantId = identityGen();
  const deviceId = identityGen();

  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const newId: IdSource = createUuidV7Generator({
    now: () => nowMs,
    randomBytes: (n) => prngBytes(prng, n),
  });

  const snapshot: DirectorySnapshot = {
    tenantId,
    users: new Map<string, { status: string }>([
      [adminId, { status: 'active' }],
      [readerId, { status: 'active' }],
      [secretReaderId, { status: 'active' }],
      [zeroGrantId, { status: 'active' }],
    ]),
    roles: new Map<string, DirectoryRole>([
      [ROLE_ADMIN, role('tenant', ['fixture.create', 'fixture.read', 'fixture.read_secret'])],
      // The UNAUTHORIZED caller for the gating test: may read items, may NOT read secrets.
      [ROLE_READER, role('store', ['fixture.read'])],
      // The POSITIVE control (T-14b): identical except it holds the gating permission.
      [ROLE_SECRET_READER, role('store', ['fixture.read', 'fixture.read_secret'])],
    ]),
    grantsByUser: new Map<string, readonly DirectoryGrant[]>([
      [adminId, [{ roleId: ROLE_ADMIN, storeId: null }]],
      [readerId, [{ roleId: ROLE_READER, storeId }]],
      [secretReaderId, [{ roleId: ROLE_SECRET_READER, storeId }]],
      [zeroGrantId, []],
    ]),
  };

  // ONE assembly: the evaluator resolves ids in the SAME registry object the runtime enforces
  // against (see createModuleRuntime's header).
  const registry = registerModules<HarnessDatabase>([module]);
  const evaluator = new PermissionEvaluator(registry.permissions, {
    load: () => Promise.resolve(snapshot),
  });
  await evaluator.prime();

  const projectionRegistry = new ProjectionRegistry<HarnessDatabase>();
  projectionRegistry.register({
    id: module.id,
    tables: module.projections.tables,
    appliers: Object.fromEntries(
      Object.entries(module.operations).map(([type, op]) => [type, op.apply]),
    ),
  } as ModuleProjectionManifest<HarnessDatabase>);
  const engine = createProjectionEngine(db, projectionRegistry);

  const appended: SignedOperation[] = [];
  const store = new SqliteOpStore(driver, db);

  const runtime = createModuleRuntime<HarnessDatabase>(registry, db, {
    device: { tenantId, storeId, deviceId },
    evaluator,
    store,
    crypto: noblePort,
    clock: { now: () => nowMs },
    idSource: newId,
    location: { getBestFix: (): Location | null => null },
    signingKey: { getSigningKey: () => keypair.secretKey },
    applyProjection: async (op: SignedOperation) => {
      appended.push(op);
      await engine.applyAppendedOp(op);
    },
    syncScheduler: { schedule: () => undefined },
  });

  // ENROLL THE DEVICE FIRST (05 §9.5): the first op on a device must be `auth.device_enrolled`, so
  // without this every command in the suite fails the genesis rule rather than the thing under
  // test. Emitted through the real sanctioned-emission channel (04 §5.1), not hand-inserted.
  //
  // `appended` is cleared afterwards so each test's assertions count ITS ops — a genesis op sitting
  // in the array would make `appended[0]` mean "the enrolment", and `toHaveLength(1)` would be
  // asserting the wrong op.
  await runtime.commands.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: { enrolledDeviceId: deviceId },
    userId: adminId,
  });
  appended.length = 0;

  return {
    db,
    registry,
    module,
    commands: runtime.commands,
    queries: runtime.queries,
    evaluator,
    newId,
    prng,
    tenantId,
    storeId,
    adminId,
    readerId,
    secretReaderId,
    zeroGrantId,
    deviceId,
    appended,
    advanceClock: (ms: number) => {
      nowMs += ms;
    },
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}
