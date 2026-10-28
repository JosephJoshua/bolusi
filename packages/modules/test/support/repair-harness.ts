// A full `repair` runtime over in-memory SQLite: the real command and query runtimes, the real
// projection engine and the real client migrations, with the agreed role split — a cashier, two
// technicians, the owners (only they cancel) and a user with no grants. Built the same way as the notes harness.
import { CamelCasePlugin, Kysely } from 'kysely';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { MediaRef, SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, randomBytes as prngBytes, opRowOf } from '@bolusi/test-support';
import { openMemoryDriver } from '@bolusi/sqlite-test-driver';

import {
  assemblePermissionRegistry,
  bytesToBase64,
  bytesToHex,
  createModuleRuntime,
  insertOpLogRow,
  operationFromSignedCoreJcs,
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
const OWNER_ROLE = 'role-owner';
const STORE_OWNER_ROLE = 'role-store-owner';
const P = REPAIR_PERMISSION;

const role = (permissionIds: readonly string[], scopeType = 'store'): DirectoryRole => ({
  scopeType,
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
  /** The device's Ed25519 public key, base64 — what a server's devices sidecar would carry. */
  readonly signingKeyPublic: string;
  readonly cashierId: string;
  readonly technicianId: string;
  readonly technician2Id: string;
  readonly zeroUserId: string;
  /** Holds every repair permission tenant-wide, as the franchise owner does. */
  readonly ownerId: string;
  /**
   * May hide intake options at this store (not change the franchise's lists), cancel repairs and
   * set the store's cancellation fees.
   */
  readonly storeOwnerId: string;
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
  /** Moves the device's clock on, so changes after it are signed that much later. */
  advance(ms: number): void;
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
  const [cashierId, technicianId, technician2Id, zeroUserId, ownerId, storeOwnerId] =
    shared?.users ?? [staticIds(), staticIds(), staticIds(), staticIds(), staticIds(), staticIds()];
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
            [cashierId!, technicianId!, technician2Id!, zeroUserId!, ownerId!, storeOwnerId!].map(
              (id) => [id, { status: 'active' as const }],
            ),
          ),
          roles: new Map<string, DirectoryRole>([
            [CASHIER_ROLE, role([P.read, P.intake, P.assign, P.quoteChange, P.handover])],
            [TECHNICIAN_ROLE, role([P.read, P.work])],
            [OWNER_ROLE, role(Object.values(P), 'tenant')],
            [
              STORE_OWNER_ROLE,
              role([
                P.read,
                P.intake,
                P.quoteChange,
                P.hideIntakeOptions,
                P.cancel,
                P.discount,
                P.setCancelFees,
                P.correctDownPayment,
                P.setPrintSettings,
                P.setUncollectedDays,
                P.warrantyException,
              ]),
            ],
          ]),
          grantsByUser: new Map<string, readonly DirectoryGrant[]>([
            [cashierId!, [{ roleId: CASHIER_ROLE, storeId }]],
            [technicianId!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [technician2Id!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [zeroUserId!, []],
            [ownerId!, [{ roleId: OWNER_ROLE, storeId: null }]],
            [storeOwnerId!, [{ roleId: STORE_OWNER_ROLE, storeId }]],
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
    signingKeyPublic: bytesToBase64(keypair.publicKey),
    cashierId: cashierId!,
    technicianId: technicianId!,
    technician2Id: technician2Id!,
    zeroUserId: zeroUserId!,
    ownerId: ownerId!,
    storeOwnerId: storeOwnerId!,
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
        .select(['signedCoreJcs', 'hash', 'signature'])
        .where('deviceId', '=', deviceId)
        .where('type', 'like', 'repair.%')
        .orderBy('seq', 'asc')
        .execute();
      return rows.map((row) => operationFromSignedCoreJcs(row.signedCoreJcs, row));
    },
    deliverPulled: async (op, arrivalSeq) => {
      await insertOpLogRow(db, opRowOf(op), {
        syncStatus: 'synced',
        syncedAt: clock.value,
        arrivalSeq,
      });
      await engine.applyPulledOp(op);
    },
    advance: (ms: number): void => {
      clock.value += ms;
    },
    photo: (n: number): MediaRef => {
      photoCounter += 1;
      const hex = (n * 1000 + photoCounter).toString(16).padStart(12, '0');
      return {
        mediaId: `01920000-0000-7000-8000-${hex}`,
        // Digest-shaped (random hex), so size and compression measurements see a real hash.
        sha256: bytesToHex(prngBytes(mulberry32(n * 1000 + photoCounter), 32)),
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
      { item: 'screen', label: null, state: 'issue', note: 'retak kiri atas' },
      { item: 'speaker', label: null, state: 'ok', note: '' },
    ],
    peripherals: [
      { item: 'charger', label: null },
      { item: 'case', label: null },
    ],
    quoteLines: [
      { kind: 'part', description: 'LCD A14 original', amount: 650_000 },
      { kind: 'labour', description: 'Pasang LCD', amount: 100_000 },
    ],
    photos: ['front', 'back', 'left', 'right', 'top', 'bottom'].map((slot, i) => ({
      slot,
      label: null,
      ref: h.photo(i + 1),
    })),
    ...overrides,
  };
}
