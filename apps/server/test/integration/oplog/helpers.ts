// Shared harness for the server op-acceptance pipeline suite (task 07; 05 §8–9, 10-db §3).
//
// Real PostgreSQL 16 in a container, over the real `pg` driver (D16, task 81) — cloned per file
// from the pre-migrated template, so the append-only trigger, RLS FORCE/policies, the
// tenant_op_counters row lock, jsonb AND the driver's int8-as-string marshalling all behave as
// production. The pipeline under test runs through `appForTenant` (SET LOCAL ROLE bolusi_app), so
// RLS + the read-append grant on `operations` are actually exercised, never bypassed vacuously
// (testing-guide §2.5). Seeding uses the owner handle (bypasses RLS) — a fixture's job is to put
// rows on the other side of the boundary for a probe to fail to reach.
//
// WHY NOT PGlite ANY MORE — the old header's stated reason was FALSE. It read: "`pg` is
// boundary-locked to packages/db-server, so apps/server test code cannot open a real-Postgres
// pool." apps/server never needed `pg`; it needed a `Kysely<DB>` over a real database, and
// `@bolusi/db-server/testing`'s `createTestDatabase` hands it one — clone + stamp assertion +
// `pg.Pool` + CamelCasePlugin all owned inside db-server, so `pg` still never crosses the boundary
// (task 81's ruling; the boundary is discharged by code, not asserted by a comment). PGlite was
// also measurably BLIND to the silent int8 class the pipeline's serverSeq accounting depends on
// (D16 / T-14f: 14/14 GREEN on PGlite vs 4 RED on real `pg`), which is the whole reason to move.
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect, inject } from 'vitest';
import { z } from 'zod';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import type { OpRegistry, OplogPipelineDeps } from '../../../src/oplog/types.js';
import { ProjectionRegistry, type CryptoPort } from '@bolusi/core';
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { mulberry32, uuidV7, type ChainWorld } from '@bolusi/test-support';

/** §6.3 request-handler role — NOBYPASSRLS; what makes RLS undefeatable from the pipeline. */
export const APP_ROLE = 'bolusi_app';

export interface OplogTestDb {
  /**
   * Owner handle. Seeding goes here — the container's default `postgres` user is a SUPERUSER, so it
   * bypasses RLS even under FORCE, which is exactly what a fixture needs and a PROBE must never use.
   */
  readonly db: Kysely<DB>;
  /** The pipeline path: `forTenant` running `SET LOCAL ROLE bolusi_app` first → RLS enforced. */
  readonly appForTenant: ForTenant;
  /** `forTenant` WITHOUT the role switch (superuser) — the non-vacuous control (sees across tenants). */
  readonly ownerForTenant: ForTenant;
  /** Every SQL string the app-role path executed, in order (FOR UPDATE spy, testing-guide T-11). */
  readonly appStatements: string[];
  /** Provenance: which real PostgreSQL database answered (T-14d). Printed by suites that assert it. */
  readonly provenance: string;
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
  const appStatements: string[] = [];

  // The seam owns the clone + stamp assertion + `pg.Pool` + CamelCasePlugin (§2.8). We only pass an
  // onQuery spy: capture EVERYTHING (owner seeding + app path) and let the FOR UPDATE spy filter —
  // the seeding noise on the owner handle would otherwise bury the app path's statements.
  const { db, provenance, close } = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
    { onQuery: (statement) => appStatements.push(statement) },
  );

  return {
    db,
    appForTenant: forTenantOn(db, APP_ROLE),
    ownerForTenant: forTenantOn(db),
    appStatements,
    provenance,
    close,
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
  // The one genuinely TENANT-scoped v0 op type (01 §6): storeId null, folds into user_prefs. Tests
  // that need a legitimate tenant-null op (e.g. the SEC-SYNC-09 pull-scope probe) use this, not a
  // store-scoped notes op with a forced null store (which task 25's applier now rejects loudly).
  'platform.user_locale_changed': z.object({ locale: z.string() }).loose(),
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
  /** Projection appliers (04 §4). Default: empty — the pipeline folds nothing (honest v0 state). */
  readonly projections?: ProjectionRegistry<DB>;
}

export function makeDeps(options: MakeDepsOptions): OplogPipelineDeps {
  const clock = options.clock ?? makeFakeClock();
  return {
    forTenant: options.forTenant,
    crypto: options.crypto ?? serverCryptoPort,
    now: () => clock.now(),
    newId: options.newId ?? makeIdSource(),
    registry: options.registry ?? testRegistry,
    projections: options.projections ?? new ProjectionRegistry<DB>(),
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
