// A full `notes` runtime over better-sqlite3 `:memory:` (testing-guide §2.1 L2): the REAL command
// runtime, the REAL query runtime (sharing one enforcement point via `createModuleRuntime`), the
// REAL projection engine, and the REAL client migrations + Kysely dialect. `execute(createNote)` →
// a row a `listNotes`/`getNote` can read; a denial → a `PERMISSION_DENIED` throw plus a durable
// denial op — every step between is production code (T-7).
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';

import {
  assemblePermissionRegistry,
  createModuleRuntime,
  createProjectionEngine,
  createUuidV7Generator,
  InvalidationBus,
  PermissionEvaluator,
  registerModules,
  type AnyModuleDefinition,
  type CommandIdentity,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type ModulePermissionManifest,
  type ModuleRuntime,
  type OpAppendStore,
  type OpAppendTx,
} from '@bolusi/core';

import { notesModule } from '../../src/notes/index.js';
import { openMemoryDriver } from './better-sqlite3-driver.js';

/** The op store over the REAL driver: one driver-level transaction per command, shared with the
 *  Kysely handle the projection engine writes through — what makes append+project atomic (04 §5.1).
 *  Copied verbatim from core's L2 harness (the shape `@bolusi/db-client` binds in production). */
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

const ROLE_NOTES = 'role-notes';
const NOTES_PERMISSION_IDS = ['notes.create', 'notes.edit', 'notes.archive', 'notes.read'];

const role = (scopeType: 'tenant' | 'store', permissionIds: readonly string[]): DirectoryRole => ({
  scopeType,
  permissionIdsJson: JSON.stringify(permissionIds),
});

export interface Harness {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly db: Kysely<ClientDatabase>;
  readonly engine: ReturnType<typeof createProjectionEngine<ClientDatabase>>;
  readonly invalidation: InvalidationBus;
  /** Holds every notes permission, granted in the device's store. */
  readonly notesUserId: string;
  /** Holds NO grants — the literal 04 §8 permission-denial case. */
  readonly zeroUserId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  identity(userId: string): CommandIdentity;
  /** Deliver a REMOTE (foreign-device) op through the pull path: insert it synced, then
   *  `applyPulledOp` — the seam a sync pull uses (api/01 §4), for the live-update test. */
  deliverPulled(op: SignedOperation, serverSeq: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open a fresh notes runtime. `notesUserId` holds all four notes permissions (a store-scoped role
 * granted in the device store); `zeroUserId` holds none (04 §8's zero-grant adversary). The device
 * is enrolled first (05 §9.5) so commands can chain.
 */
export async function openHarness(seed: number): Promise<Harness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const registry = registerModules([notesModule as unknown as AnyModuleDefinition<ClientDatabase>]);
  const invalidation = new InvalidationBus();
  const engine = createProjectionEngine(db, registry.projections, { invalidation });

  const prng = mulberry32(seed);
  const clock = { value: 1_726_000_000_000 };
  const staticIds = createUuidV7Generator({
    now: () => 1_726_000_000_000,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = staticIds();
  const storeId = staticIds();
  const notesUserId = staticIds();
  const zeroUserId = staticIds();
  const deviceId = staticIds();
  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const newId = createUuidV7Generator({
    now: () => clock.value,
    randomBytes: (n) => prngBytes(prng, n),
  });

  const snapshot: DirectorySnapshot = {
    tenantId,
    users: new Map([
      [notesUserId, { status: 'active' }],
      [zeroUserId, { status: 'active' }],
    ]),
    roles: new Map<string, DirectoryRole>([[ROLE_NOTES, role('store', NOTES_PERMISSION_IDS)]]),
    grantsByUser: new Map<string, readonly DirectoryGrant[]>([
      [notesUserId, [{ roleId: ROLE_NOTES, storeId }]],
      [zeroUserId, []],
    ]),
  };
  const evaluator = new PermissionEvaluator(
    assemblePermissionRegistry([notesModule as unknown as ModulePermissionManifest]),
    { load: () => Promise.resolve(snapshot) },
  );
  await evaluator.prime();

  const runtime = createModuleRuntime(registry, db, {
    device: { tenantId, storeId, deviceId },
    evaluator,
    store: new SqliteOpStore(driver, db),
    crypto: noblePort,
    clock: { now: () => (clock.value += 1) },
    idSource: newId,
    location: { getBestFix: () => null },
    signingKey: { getSigningKey: () => keypair.secretKey },
    applyProjection: (op) => engine.applyAppendedOp(op).then(() => undefined),
    syncScheduler: { schedule: () => undefined },
  });

  // Genesis (05 §9.5) — the device must be enrolled before it can command.
  await runtime.commands.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: { enrolledDeviceId: deviceId },
    userId: notesUserId,
  });

  return {
    runtime,
    db,
    engine,
    invalidation,
    notesUserId,
    zeroUserId,
    tenantId,
    storeId,
    deviceId,
    identity: (userId: string): CommandIdentity => ({ tenantId, storeId, userId, deviceId }),
    deliverPulled: async (op: SignedOperation, serverSeq: number): Promise<void> => {
      await db
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
          location: null,
          source: op.source,
          agentInitiated: op.agentInitiated ? 1 : 0,
          agentConversationId: op.agentConversationId,
          previousHash: op.previousHash,
          hash: op.hash,
          signature: op.signature,
          signedCoreJcs: `jcs:${op.id}`,
          syncStatus: 'synced',
          serverSeq,
          syncedAt: clock.value,
        })
        .execute();
      await engine.applyPulledOp(op);
    },
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}
