// A full `repair` runtime over in-memory SQLite: the real command and query runtimes, the real
// projection engine and the real client migrations, with the agreed role split — a cashier, two
// technicians and a user with no grants. Built the same way as the notes harness.
import { CamelCasePlugin, Kysely } from 'kysely';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { MediaRef, SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { openMemoryDriver } from '@bolusi/sqlite-test-driver';

import {
  assemblePermissionRegistry,
  createModuleRuntime,
  createProjectionEngine,
  SearchIndexCache,
  createUuidV7Generator,
  PermissionEvaluator,
  registerModules,
  type AnyModuleDefinition,
  type DirectoryGrant,
  type DirectoryRole,
  type ModulePermissionManifest,
  type ModuleRuntime,
} from '@bolusi/core';

import { repairModule, REPAIR_PERMISSION } from '../../src/repair/index.js';
import { SqliteOpStore } from './harness.js';

const CASHIER_ROLE = 'role-cashier';
const TECHNICIAN_ROLE = 'role-technician';
const P = REPAIR_PERMISSION;

const role = (permissionIds: readonly string[]): DirectoryRole => ({
  scopeType: 'store',
  permissionIdsJson: JSON.stringify(permissionIds),
});

// Query rows are read loosely in tests; the query modules own the real row types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions pick fields per test
export type QueryRow = any;

export interface RepairHarness {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly db: Kysely<ClientDatabase>;
  readonly engine: ReturnType<typeof createProjectionEngine<ClientDatabase>>;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly cashierId: string;
  readonly technicianId: string;
  readonly technician2Id: string;
  readonly zeroUserId: string;
  /** Run a repair command as `userId`. */
  run<K extends keyof typeof repairModule.commands>(
    command: K,
    input: Parameters<(typeof repairModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run a repair query as `userId`. */
  query<K extends keyof typeof repairModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Every op this device appended, in seq order (for replaying onto another harness). */
  ownOps(): Promise<SignedOperation[]>;
  deliverPulled(op: SignedOperation, arrivalSeq: number): Promise<void>;
  photo(n: number): MediaRef;
  close(): Promise<void>;
}

export async function openRepairHarness(
  seed: number,
  shared?: { tenantId: string; storeId: string; users: readonly string[] },
): Promise<RepairHarness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const registry = registerModules([
    repairModule as unknown as AnyModuleDefinition<ClientDatabase>,
  ]);
  const engine = createProjectionEngine(db, registry.projections);

  const prng = mulberry32(seed);
  const clock = { value: 1_726_000_000_000 + seed * 1_000_000 };
  const staticIds = createUuidV7Generator({
    now: () => 1_726_000_000_000,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = shared?.tenantId ?? staticIds();
  const storeId = shared?.storeId ?? staticIds();
  const [cashierId, technicianId, technician2Id, zeroUserId] = shared?.users ?? [
    staticIds(),
    staticIds(),
    staticIds(),
    staticIds(),
  ];
  const deviceId = staticIds();
  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const newId = createUuidV7Generator({
    now: () => clock.value,
    randomBytes: (n) => prngBytes(prng, n),
  });

  const evaluator = new PermissionEvaluator(
    assemblePermissionRegistry([repairModule as unknown as ModulePermissionManifest]),
    {
      load: () =>
        Promise.resolve({
          tenantId,
          users: new Map(
            [cashierId!, technicianId!, technician2Id!, zeroUserId!].map((id) => [
              id,
              { status: 'active' as const },
            ]),
          ),
          roles: new Map<string, DirectoryRole>([
            [CASHIER_ROLE, role([P.read, P.intake, P.assign, P.quoteChange, P.cancel, P.handover])],
            [TECHNICIAN_ROLE, role([P.read, P.work])],
          ]),
          grantsByUser: new Map<string, readonly DirectoryGrant[]>([
            [cashierId!, [{ roleId: CASHIER_ROLE, storeId }]],
            [technicianId!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [technician2Id!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [zeroUserId!, []],
          ]),
        }),
    },
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
    // The device's live search cache, fed by this engine's applies (local and pulled).
    search: new SearchIndexCache(engine.invalidation),
  });

  await runtime.commands.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: { enrolledDeviceId: deviceId },
    userId: cashierId!,
  });

  let photoCounter = 0;

  return {
    runtime,
    db,
    engine,
    tenantId,
    storeId,
    deviceId,
    cashierId: cashierId!,
    technicianId: technicianId!,
    technician2Id: technician2Id!,
    zeroUserId: zeroUserId!,
    run: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        repairModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    query: async (query, input, userId) => {
      return (await runtime.queries.execute(repairModule.queries[query] as never, input as never, {
        tenantId,
        storeId,
        userId,
        deviceId,
      })) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    ownOps: async () => {
      const rows = await db
        .selectFrom('operations')
        .selectAll()
        .where('deviceId', '=', deviceId)
        .where('type', 'like', 'repair.%')
        .orderBy('seq', 'asc')
        .execute();
      return rows.map(
        (row) =>
          ({
            id: row.id,
            tenantId: row.tenantId,
            storeId: row.storeId,
            userId: row.userId,
            deviceId: row.deviceId,
            seq: row.seq,
            type: row.type,
            entityType: row.entityType,
            entityId: row.entityId,
            schemaVersion: row.schemaVersion,
            payload: JSON.parse(row.payload),
            timestamp: row.timestampMs,
            location: null,
            source: row.source,
            agentInitiated: row.agentInitiated === 1,
            agentConversationId: row.agentConversationId,
            previousHash: row.previousHash,
            hash: row.hash,
            signature: row.signature,
          }) as SignedOperation,
      );
    },
    deliverPulled: async (op, arrivalSeq) => {
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
          arrivalSeq,
          syncedAt: clock.value,
        })
        .execute();
      await engine.applyPulledOp(op);
    },
    photo: (n: number): MediaRef => {
      photoCounter += 1;
      const hex = (n * 1000 + photoCounter).toString(16).padStart(12, '0');
      return {
        mediaId: `01920000-0000-7000-8000-${hex}`,
        sha256: (n % 10).toString().repeat(64),
        mime: 'image/jpeg',
        type: 'image',
        sizeBytes: 120_000,
        capturedAt: clock.value,
        location: null,
        userId: cashierId!,
        deviceId,
      };
    },
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** A complete intake for `openTicket`, overridable per test. */
export function intake(h: RepairHarness, overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: 'Yohanis Wenda', phone: '0812-4455-6677' },
    device: { brand: 'Samsung', model: 'Galaxy A14', color: 'Hitam', imei: '356789104455667' },
    complaint: 'Layar retak, sentuhan tidak responsif',
    checklist: [
      { item: 'screen', state: 'issue', note: 'retak kiri atas' },
      { item: 'speaker', state: 'ok', note: '' },
    ],
    peripherals: ['charger', 'case'],
    quoteLines: [
      { kind: 'part', description: 'LCD A14 original', amount: 650_000 },
      { kind: 'labour', description: 'Pasang LCD', amount: 100_000 },
    ],
    photos: {
      front: h.photo(1),
      back: h.photo(2),
      left: h.photo(3),
      right: h.photo(4),
      top: h.photo(5),
      bottom: h.photo(6),
    },
    ...overrides,
  };
}
