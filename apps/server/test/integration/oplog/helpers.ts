// Shared harness for the server op-acceptance pipeline suite (task 07; 05 §8–9, 10-db §3).
//
// PGlite embeds a real PostgreSQL, so the append-only trigger, RLS FORCE/policies, the
// tenant_op_counters row lock, and jsonb all behave as production — the fast L3 loop
// (testing-guide §2.1). The pipeline under test runs through `appForTenant` (SET LOCAL ROLE
// bolusi_app), so RLS + the read-append grant on `operations` are actually exercised, never
// bypassed vacuously (testing-guide §2.5). Seeding uses the owner handle (bypasses RLS) — a
// fixture's job is to put rows on the other side of the boundary for a probe to fail to reach.
//
// WHY PGLITE (not the db-server test:rls Postgres lane): `pg` is boundary-locked to
// packages/db-server, so apps/server test code cannot open a real-Postgres pool. The genuinely
// CONCURRENT serverSeq race (two pool connections) therefore lives in
// packages/db-server/test/oplog-server-seq-concurrency.test.ts under `pnpm test:rls`; this lane
// proves the pipeline's per-op accounting + that it emits the FOR UPDATE lock (query spy).
import {
  CamelCasePlugin,
  Kysely,
  PGliteDialect,
  sql,
  type LogEvent,
  type Selectable,
} from 'kysely';
import { z } from 'zod';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import type { OpRegistry, OplogPipelineDeps } from '../../../src/oplog/types.js';
import type { CryptoPort } from '@bolusi/core';
import { migrateToLatest, type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { mulberry32, uuidV7, type ChainWorld } from '@bolusi/test-support';

/** §6.3 request-handler role — NOBYPASSRLS; what makes RLS undefeatable from the pipeline. */
export const APP_ROLE = 'bolusi_app';

/** 10-db §11.4 shared camel-case config (must match production's mapping). */
const CAMEL_CASE_OPTIONS = { underscoreBetweenUppercaseLetters: true } as const;

export interface OplogTestDb {
  /** Owner/superuser handle (PGlite connects as superuser → bypasses RLS). Seeding goes here. */
  readonly db: Kysely<DB>;
  /** The pipeline path: `forTenant` running `SET LOCAL ROLE bolusi_app` first → RLS enforced. */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch (superuser) — the non-vacuous control (sees across tenants). */
  readonly ownerForTenant: ForTenant;
  /** Every SQL string the app-role path executed, in order (FOR UPDATE spy, testing-guide T-11). */
  readonly appStatements: string[];
  readonly close: () => Promise<void>;
}

function forTenantOn(db: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      if (role !== undefined) {
        await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      }
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

export async function makeOplogTestDb(): Promise<OplogTestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;

  const appStatements: string[] = [];
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ ...CAMEL_CASE_OPTIONS })],
    log: (event: LogEvent) => {
      // Only the app-role path's statements are of interest to the FOR UPDATE spy; seeding noise
      // on the owner handle would bury it. We tag by capturing everything and the spy filters.
      appStatements.push(event.query.sql);
    },
  });
  await migrateToLatest(db);

  return {
    db,
    appForTenant: forTenantOn(db, APP_ROLE),
    ownerForTenant: forTenantOn(db),
    appStatements,
    close: () => db.destroy(),
  };
}

// ---------------------------------------------------------------------------------------------
// A deterministic FakeClock + id source (testing-guide T-6: no real clock/RNG in tests).

export interface FakeClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function makeFakeClock(startMs = 1_726_100_000_000): FakeClock {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * A distinct, deterministic UUIDv7 per seed — for extra users / entity ids a case invents.
 *
 * v7 specifically: `entityId` is `zUuidV7` (05 §2.1) and ids are v7 system-wide (10-db §2). A v4
 * id in `entityId` fails `zSignedCore.parse` inside the hash path, which surfaces as
 * BAD_SIGNATURE — a scope test built on one would reject for the wrong reason.
 */
export function testId(seed: number): string {
  return uuidV7(mulberry32(seed), 1_726_200_000_000 + seed);
}

/** A deterministic UUIDv7-shaped id source for anomaly rows (unique per call, no RNG). */
export function makeIdSource(seed = 1): () => string {
  let counter = seed;
  return () => {
    counter += 1;
    const tail = counter.toString(16).padStart(12, '0');
    return `0198f100-0000-7000-8000-${tail}`;
  };
}

// ---------------------------------------------------------------------------------------------
// The registry seam (task 11's @bolusi/modules is a placeholder). Covers exactly the types the
// suite pushes; an unlisted type resolves `unknown` → UNKNOWN_TYPE, and a schema failure →
// SCHEMA_INVALID. Both prongs are exercised as distinct tests.

const SCHEMAS: Record<string, z.ZodType> = {
  'auth.device_enrolled': z
    .object({ storeId: z.string(), deviceName: z.string(), devicePublicKeyB64: z.string() })
    .loose(),
  'auth.pin_changed': z.object({ targetUserId: z.string(), verifierRef: z.string() }).loose(),
  'auth.pin_reset': z.object({ targetUserId: z.string(), verifierRef: z.string() }).loose(),
  'auth.pin_lockout_cleared': z.object({}).loose(),
  'platform.conflict_detected': z.object({ opAId: z.string(), opBId: z.string() }).loose(),
  'platform.conflict_acknowledged': z.object({ conflictId: z.string() }).loose(),
  'notes.note_created': z.object({ title: z.string(), body: z.string() }).loose(),
  'notes.note_body_edited': z.object({ body: z.string() }).loose(),
};

export const testRegistry: OpRegistry = {
  resolve(type: string) {
    const schema = SCHEMAS[type];
    if (schema === undefined) return { kind: 'unknown' };
    return { kind: 'known', validate: (payload) => schema.safeParse(payload).success };
  },
};

/** A CryptoPort spy over the production `serverCryptoPort` — counts verify() calls. */
export interface CryptoSpy {
  readonly port: CryptoPort;
  verifyCalls(): number;
}

export function makeCryptoSpy(base: CryptoPort = serverCryptoPort): CryptoSpy {
  let verifyCalls = 0;
  const port: CryptoPort = {
    ...base,
    verify(signature, message, publicKey) {
      verifyCalls += 1;
      return base.verify(signature, message, publicKey);
    },
  };
  return { port, verifyCalls: () => verifyCalls };
}

export interface MakeDepsOptions {
  readonly forTenant: ForTenant;
  readonly clock?: FakeClock;
  readonly crypto?: CryptoPort;
  readonly registry?: OpRegistry;
  readonly newId?: () => string;
}

export function makeDeps(options: MakeDepsOptions): OplogPipelineDeps {
  const clock = options.clock ?? makeFakeClock();
  return {
    forTenant: options.forTenant,
    crypto: options.crypto ?? serverCryptoPort,
    now: () => clock.now(),
    newId: options.newId ?? makeIdSource(),
    registry: options.registry ?? testRegistry,
  };
}

// ---------------------------------------------------------------------------------------------
// Seeding.

export interface SeedWorldOptions {
  readonly deviceStatus?: 'active' | 'revoked';
  readonly deviceKind?: 'member' | 'system';
  readonly lastSeq?: number;
  readonly lastHash?: string | null;
  readonly lastSyncAt?: number | null;
  readonly userStatus?: 'active' | 'deactivated';
  /** Seed the tenant_op_counters row at this value (default 1). */
  readonly counterStart?: number;
  readonly createdAt?: number;
}

/**
 * Seeds tenant + counter + store + device + user for a built `ChainWorld` (its keypair is what
 * the device's signing_key_public holds, so its ops verify server-side). Owner handle only.
 */
export async function seedWorld(
  db: Kysely<DB>,
  world: ChainWorld,
  options: SeedWorldOptions = {},
): Promise<void> {
  const createdAt = BigInt(options.createdAt ?? 1_726_000_000_000);
  await db
    .insertInto('tenants')
    .values({ id: world.tenantId, name: `tenant-${world.tenantId}`, createdAt })
    .execute();
  await db
    .insertInto('tenantOpCounters')
    .values({ tenantId: world.tenantId, nextServerSeq: BigInt(options.counterStart ?? 1) })
    .execute();
  await db
    .insertInto('stores')
    .values({
      id: world.storeId,
      tenantId: world.tenantId,
      name: `store-${world.storeId}`,
      createdAt,
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: world.deviceId,
      tenantId: world.tenantId,
      storeId: options.deviceKind === 'system' ? null : world.storeId,
      kind: options.deviceKind ?? 'member',
      signingKeyPublic: world.publicKeyB64,
      status: options.deviceStatus ?? 'active',
      ...(options.deviceStatus === 'revoked' ? { revokedAt: createdAt } : {}),
      enrolledAt: createdAt,
      lastSeq: BigInt(options.lastSeq ?? 0),
      lastHash: options.lastHash ?? null,
      lastSyncAt: options.lastSyncAt === undefined ? null : BigInt(options.lastSyncAt as number),
    })
    .execute();
  await db
    .insertInto('users')
    .values({
      id: world.userId,
      tenantId: world.tenantId,
      name: `user-${world.userId}`,
      status: options.userStatus ?? 'active',
      createdAt,
    })
    .execute();
}

/**
 * Seed ONLY the devices row for a world whose tenant/store/user already exist — a second device
 * inside an existing tenant, which is what a cross-device splice (SEC-OPLOG-04) needs.
 */
export async function seedDevice(
  db: Kysely<DB>,
  world: ChainWorld,
  options: SeedWorldOptions = {},
): Promise<void> {
  const createdAt = BigInt(options.createdAt ?? 1_726_000_000_000);
  await db
    .insertInto('devices')
    .values({
      id: world.deviceId,
      tenantId: world.tenantId,
      storeId: options.deviceKind === 'system' ? null : world.storeId,
      kind: options.deviceKind ?? 'member',
      signingKeyPublic: world.publicKeyB64,
      status: options.deviceStatus ?? 'active',
      ...(options.deviceStatus === 'revoked' ? { revokedAt: createdAt } : {}),
      enrolledAt: createdAt,
      lastSeq: BigInt(options.lastSeq ?? 0),
      lastHash: options.lastHash ?? null,
      lastSyncAt: options.lastSyncAt === undefined ? null : BigInt(options.lastSyncAt as number),
    })
    .execute();
}

/** Seed an extra user in a tenant (membership directory). */
export async function seedUser(
  db: Kysely<DB>,
  tenantId: string,
  userId: string,
  status: 'active' | 'deactivated' = 'active',
): Promise<void> {
  await db
    .insertInto('users')
    .values({ id: userId, tenantId, name: `user-${userId}`, status, createdAt: 1_726_000_000_000n })
    .execute();
}

/** Seed a role + its permissions, and grant it to a user (tenant-scoped). */
export async function grantRole(
  db: Kysely<DB>,
  args: {
    tenantId: string;
    userId: string;
    roleId: string;
    roleName: string;
    permissionIds: readonly string[];
  },
): Promise<void> {
  await db
    .insertInto('roles')
    .values({
      id: args.roleId,
      tenantId: args.tenantId,
      name: args.roleName,
      scopeType: 'tenant',
      isSystemDefault: args.roleName === 'main_owner',
      createdAt: 1_726_000_000_000n,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  for (const permissionId of args.permissionIds) {
    const [moduleName, action] = permissionId.split('.');
    await db
      .insertInto('permissions')
      .values({
        id: permissionId,
        module: moduleName ?? permissionId,
        action: action ?? permissionId,
        scope: 'tenant',
        description: permissionId,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await db
      .insertInto('rolePermissions')
      .values({ roleId: args.roleId, permissionId, tenantId: args.tenantId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  await db
    .insertInto('userRoles')
    .values({ tenantId: args.tenantId, userId: args.userId, roleId: args.roleId, storeId: null })
    .execute();
}

// The return types below are annotated, not inferred: the inferred row type names the generated
// table interfaces, which this package does not import (only `DB` is exported — growing db-server's
// export surface is a decision, never an accident: src/index.ts, test/export-surface.test.ts).
// Indexing the imported `DB` names the same rows through the one type the package does export.
/** Read the accepted operation rows for a tenant (owner handle), ascending by serverSeq. */
export async function readOps(
  db: Kysely<DB>,
  tenantId: string,
): Promise<Selectable<DB['operations']>[]> {
  return db
    .selectFrom('operations')
    .selectAll()
    .where('tenantId', '=', tenantId)
    .orderBy('serverSeq')
    .execute();
}

/** Read the device_anomalies for a device (owner handle). */
export async function readAnomalies(
  db: Kysely<DB>,
  deviceId: string,
): Promise<Selectable<DB['deviceAnomalies']>[]> {
  return db
    .selectFrom('deviceAnomalies')
    .selectAll()
    .where('deviceId', '=', deviceId)
    .orderBy('at')
    .execute();
}
