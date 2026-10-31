// A full `repair` runtime over in-memory SQLite: the real command and query runtimes, the real
// projection engine and the real client migrations, with the agreed role split — a cashier, two
// technicians, the owners (only they cancel) and a user with no grants. Built the same way as the notes harness.
import { CamelCasePlugin, Kysely } from 'kysely';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import type { MediaRef, SignedOperation, VideoRef } from '@bolusi/schemas';
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
  type OpRuleContext,
} from '@bolusi/core';

import { APPROVAL_PERMISSION } from '../../src/approvals/index.js';
import {
  approvalsModule,
  inventoryModule,
  moneyModule,
  purchasingModule,
} from '../../src/index.js';
import { INVENTORY_PERMISSION } from '../../src/inventory/index.js';
import { MONEY_PERMISSION } from '../../src/money/index.js';
import { PURCHASING_PERMISSION } from '../../src/purchasing/index.js';
import { repairModule, REPAIR_PERMISSION } from '../../src/repair/index.js';
import { SqliteOpStore } from './harness.js';

const CASHIER_ROLE = 'role-cashier';
const TECHNICIAN_ROLE = 'role-technician';
const OWNER_ROLE = 'role-owner';
const STORE_OWNER_ROLE = 'role-store-owner';
const MANAGER_ROLE = 'role-manager';
/** The manager's limits at the harness store (core authz/limits.ts). */
export const MANAGER_LIMITS = { priceDrop: 50_000, refund: 30_000, credit: 100_000 } as const;
// A fixed id, not one from the seeded generator: drawing another would shift every id after it.
const MANAGER_ID = '0191e000-0000-7000-8000-00000000a11a';
const P = REPAIR_PERMISSION;
const M = MONEY_PERMISSION;
const I = INVENTORY_PERMISSION;
const B = PURCHASING_PERMISSION;

// Every role asks for and answers approvals; the decision's own permission says what.
const role = (permissionIds: readonly string[], scopeType = 'store'): DirectoryRole => ({
  scopeType,
  permissionIdsJson: JSON.stringify([...permissionIds, APPROVAL_PERMISSION.use]),
});

// Query rows are read loosely in tests; the query modules own the real row types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions pick fields per test
export type QueryRow = any;

export interface RepairHarness {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly db: Kysely<ClientDatabase>;
  readonly engine: ReturnType<typeof createProjectionEngine<ClientDatabase>>;
  /** Judges an op by its type's rule against this device's records, as push ingestion would.
   *  Everyone holds every permission with no limit, unless `withinLimit` says otherwise. */
  readonly checkRule: (
    op: SignedOperation,
    withinLimit?: (userId: string, permissionId: string, amount: number) => Promise<boolean>,
    /** Who holds what instead, and the server's clock (none: judged as a device does). */
    extra?: Partial<Pick<OpRuleContext<never>, 'holdsPermission' | 'receivedAt'>>,
  ) => Promise<void>;
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
  /** A Manajer: the counter's and the technician's work plus owners' decisions, within
   *  {@link MANAGER_LIMITS}. */
  readonly managerId: string;
  /** Run a repair command as `userId`. */
  run<K extends keyof typeof repairModule.commands>(
    command: K,
    input: Parameters<(typeof repairModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run an inventory command as `userId` (parts drawn for servisan). */
  runInventory<K extends keyof typeof inventoryModule.commands>(
    command: K,
    input: Parameters<(typeof inventoryModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run an inventory query as `userId`. */
  queryInventory<K extends keyof typeof inventoryModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Run a purchasing command as `userId`. */
  purchasing<K extends keyof typeof purchasingModule.commands>(
    command: K,
    input: Parameters<(typeof purchasingModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run a purchasing query as `userId`. */
  purchasingQuery<K extends keyof typeof purchasingModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Run a money command as `userId`. */
  money<K extends keyof typeof moneyModule.commands>(
    command: K,
    input: Parameters<(typeof moneyModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run a money query as `userId`. */
  moneyQuery<K extends keyof typeof moneyModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Run an approvals command as `userId`. */
  approvals<K extends keyof typeof approvalsModule.commands>(
    command: K,
    input: Parameters<(typeof approvalsModule.commands)[K]['input']['parse']>[0],
    userId: string,
  ): Promise<unknown>;
  /** Run an approvals query as `userId`. */
  approvalsQuery<K extends keyof typeof approvalsModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Run a repair query as `userId`. */
  query<K extends keyof typeof repairModule.queries>(
    query: K,
    input: unknown,
    userId: string,
  ): Promise<{ rows: readonly QueryRow[]; nextCursor: string | null }>;
  /** Whether `userId` holds `permission` here, as the screens ask it. */
  hasPermission(userId: string, permission: string): boolean;
  /** Every op this device appended, in seq order (for replaying onto another harness). */
  ownOps(): Promise<SignedOperation[]>;
  deliverPulled(op: SignedOperation, arrivalSeq: number): Promise<void>;
  photo(n: number): MediaRef;
  /** An ownership video clip, signed like a photo. */
  video(n: number): VideoRef;
  /** Moves the device's clock on, so changes after it are signed that much later. */
  advance(ms: number): void;
  /** The device's clock now, for checks that mirror a rule's time window. */
  now(): number;
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
    inventoryModule as unknown as AnyModuleDefinition<ClientDatabase>,
    purchasingModule as unknown as AnyModuleDefinition<ClientDatabase>,
    moneyModule as unknown as AnyModuleDefinition<ClientDatabase>,
    approvalsModule as unknown as AnyModuleDefinition<ClientDatabase>,
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
    assemblePermissionRegistry([
      repairModule as unknown as ModulePermissionManifest,
      inventoryModule as unknown as ModulePermissionManifest,
      purchasingModule as unknown as ModulePermissionManifest,
      moneyModule as unknown as ModulePermissionManifest,
      approvalsModule as unknown as ModulePermissionManifest,
    ]),
    {
      load: () =>
        Promise.resolve({
          tenantId,
          users: new Map(
            [
              cashierId!,
              technicianId!,
              technician2Id!,
              zeroUserId!,
              ownerId!,
              storeOwnerId!,
              MANAGER_ID,
            ].map((id) => [id, { status: 'active' as const }]),
          ),
          roles: new Map<string, DirectoryRole>([
            [
              CASHIER_ROLE,
              role([
                P.read,
                P.intake,
                P.assign,
                P.quoteChange,
                P.handover,
                M.read,
                M.receive,
                M.moveCash,
                M.countCash,
                I.read,
                I.useParts,
              ]),
            ],
            [TECHNICIAN_ROLE, role([P.read, P.work, I.read, I.useParts])],
            [
              OWNER_ROLE,
              role(
                [
                  ...Object.values(P),
                  ...Object.values(I),
                  ...Object.values(M),
                  ...Object.values(B),
                ],
                'tenant',
              ),
            ],
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
                // Categories are the business owner's alone (a tenant-wide permission).
                ...Object.values(I).filter((id) => id !== I.manageCategories),
                ...Object.values(M).filter((id) => id !== M.manageCentralAccounts),
                ...Object.values(B),
              ]),
            ],
            [
              MANAGER_ROLE,
              {
                ...role([
                  P.read,
                  P.intake,
                  P.work,
                  P.assign,
                  P.quoteChange,
                  P.handover,
                  P.cancel,
                  P.discount,
                  P.correctDownPayment,
                  P.warrantyException,
                  M.read,
                  M.receive,
                  M.moveCash,
                  M.countCash,
                  M.refund,
                  M.voidPayment,
                  M.extendCredit,
                  I.read,
                  I.useParts,
                ]),
                limits: new Map([[storeId, MANAGER_LIMITS]]),
              },
            ],
          ]),
          grantsByUser: new Map<string, readonly DirectoryGrant[]>([
            [cashierId!, [{ roleId: CASHIER_ROLE, storeId }]],
            [technicianId!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [technician2Id!, [{ roleId: TECHNICIAN_ROLE, storeId }]],
            [zeroUserId!, []],
            [ownerId!, [{ roleId: OWNER_ROLE, storeId: null }]],
            [storeOwnerId!, [{ roleId: STORE_OWNER_ROLE, storeId }]],
            [MANAGER_ID, [{ roleId: MANAGER_ROLE, storeId }]],
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
  const photo = (n: number): MediaRef => {
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
  };

  return {
    runtime,
    db,
    engine,
    checkRule: (op, withinLimit = () => Promise.resolve(true), extra = {}) =>
      registry.checkOpRule(op, {
        db: db as never,
        holdsPermission: () => Promise.resolve(true),
        withinLimit,
        sha256: (data) => noblePort.sha256(data),
        ...extra,
      }),
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
    managerId: MANAGER_ID,
    run: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        repairModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    runInventory: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        inventoryModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    queryInventory: async (query, input, userId) => {
      return (await runtime.queries.execute(
        inventoryModule.queries[query] as never,
        input as never,
        { tenantId, storeId, userId, deviceId },
      )) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    purchasing: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        purchasingModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    purchasingQuery: async (query, input, userId) => {
      return (await runtime.queries.execute(
        purchasingModule.queries[query] as never,
        input as never,
        { tenantId, storeId, userId, deviceId },
      )) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    money: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        moneyModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    moneyQuery: async (query, input, userId) => {
      return (await runtime.queries.execute(moneyModule.queries[query] as never, input as never, {
        tenantId,
        storeId,
        userId,
        deviceId,
      })) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    approvals: async (command, input, userId) => {
      const outcome = await runtime.commands.execute(
        approvalsModule.commands[command] as never,
        input as never,
        runtime.commands.createContext(userId),
      );
      return (outcome as { result?: unknown }).result;
    },
    approvalsQuery: async (query, input, userId) => {
      return (await runtime.queries.execute(
        approvalsModule.queries[query] as never,
        input as never,
        { tenantId, storeId, userId, deviceId },
      )) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    query: async (query, input, userId) => {
      return (await runtime.queries.execute(repairModule.queries[query] as never, input as never, {
        tenantId,
        storeId,
        userId,
        deviceId,
      })) as { rows: readonly QueryRow[]; nextCursor: string | null };
    },
    hasPermission: (userId, permission) =>
      runtime.commands.createContext(userId).colleagueHasPermission(userId, permission),
    ownOps: async () => {
      const rows = await db
        .selectFrom('operations')
        .select(['signedCoreJcs', 'hash', 'signature'])
        .where('deviceId', '=', deviceId)
        .where((eb) =>
          eb.or([
            eb('type', 'like', 'repair.%'),
            eb('type', 'like', 'inventory.%'),
            eb('type', 'like', 'money.%'),
            eb('type', 'like', 'purchasing.%'),
            eb('type', 'like', 'approvals.%'),
          ]),
        )
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
    now: (): number => clock.value,
    photo,
    video: (n: number): VideoRef => ({
      ...photo(n),
      mime: 'video/mp4',
      type: 'video',
      sizeBytes: 9_000_000,
    }),
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/**
 * The handover checklist with every accessory `intake` leaves (charger and case) ticked as back,
 * which is all the rule asks for; a test with other accessories passes its own.
 */
export function accessoriesBack(
  peripherals: readonly { item: string; label: string | null }[] = [
    { item: 'charger', label: null },
    { item: 'case', label: null },
  ],
) {
  return peripherals.map(({ item, label }) => ({ kind: 'accessory', item, label, done: true }));
}

/** A complete intake for `openTicket`, overridable per test. */
export function intake(h: RepairHarness, overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: 'Yohanis Wenda', phone: '0812-4455-6677' },
    device: { brand: 'Samsung', model: 'Galaxy A14', color: 'Hitam', imei: '356789104455660' },
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

/**
 * A handover the way the counter takes it: photo, signature and the rest of the bill in cash.
 * `extra` overrides any field (a note, other payments).
 */
export async function paidHandover(
  harness: RepairHarness,
  ticketId: string,
  extra: Record<string, unknown> = {},
  photos: readonly [number, number] = [7, 8],
): Promise<Record<string, unknown>> {
  const ticket = (await harness.query('getTicket', { ticketId }, harness.cashierId)).rows[0] as {
    outcome: string;
    location: string;
    quoteTotal: number;
    cancelFee: number | null;
    downPayment: number | null;
    peripherals: { item: string; label: string | null }[];
  };
  const cost = ticket.outcome === 'cancelled' ? (ticket.cancelFee ?? 0) : ticket.quoteTotal;
  const due = cost - (ticket.downPayment ?? 0);
  const finished = ticket.outcome === 'repaired' || ticket.outcome === 'cancelled';
  return {
    ticketId,
    handoverPhoto: harness.photo(photos[0]),
    signature: harness.photo(photos[1]),
    payments:
      finished && ticket.location === 'in_store' && due > 0
        ? [{ account: 'cash', amount: due }]
        : [],
    checklist: accessoriesBack(ticket.peripherals),
    ...extra,
  };
}
