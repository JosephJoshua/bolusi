// Sync integration harness (testing-guide §3.1): the REAL production `createApp` (full middleware
// chain) over real PostgreSQL 16 in a container (D16, task 81) with RLS-aware `forTenant` (SET LOCAL
// ROLE bolusi_app), the task-07 push pipeline verifying real Ed25519 chains, and a recording poke
// hub. The database is cloned per file from the pre-migrated template via `@bolusi/db-server/testing`
// — `pg` never crosses the boundary — so `set_config`, RLS FORCE/policies, the tenant_op_counters
// row lock, the append-only trigger AND the driver's int8-as-string marshalling behave as
// production. (Previously PGlite: real Postgres, but the WRONG driver — blind to the silent int8
// class the pull cursor/serverSeq accounting rides on, D16 / T-14f.) The genuinely CONCURRENT and
// crash-recovery legs (a two-connection race) live in the db-server `test:rls` lane.
//
// Fixture helpers are structured for reuse by task 26's multi-device harness (task 16 acceptance).
import { sql, type Kysely } from 'kysely';
import { expect, inject } from 'vitest';

import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import type { SignedOperation } from '@bolusi/schemas';

import { createApp } from '../../../src/app.js';
import type { ServerDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import type { OpRegistry } from '../../../src/oplog/index.js';
import type { AccessLogRecord } from '../../../src/middleware/access-log.js';
import { createVerifyToken, InMemoryTokenStore } from '../../../src/middleware/auth.js';
import { ImmediateDeliveryDispatcher } from '../../../src/push/dispatcher.js';
import { FakePushPort, type PushPort } from '../../../src/push/port.js';
import { InProcessPokeHub, type PokeScope } from '../../../src/realtime/poke-hub.js';
import { testRegistry } from '../oplog/helpers.js';

const APP_ROLE = 'bolusi_app';

/** Near the ChainBuilder default op-timestamp base (1_726_000_000_000) so a fresh device's ops are
 *  inside the 48h skew window (05 §6) — no spurious CLOCK_SKEW anomalies in the happy path. */
const CLOCK_START = 1_726_100_000_000;

export interface FakeClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function makeFakeClock(startMs = CLOCK_START): FakeClock {
  let t = startMs;
  return { now: () => t, set: (ms) => (t = ms), advance: (ms) => (t += ms) };
}

/** A seeded device ready to push/pull: its directory identity + chain builder + bearer header. */
export interface SeededDevice {
  readonly world: ChainWorld;
  readonly auth: string;
  readonly builder: ChainBuilder;
}

export interface SyncHarness {
  readonly app: ReturnType<typeof createApp>;
  /** Owner handle (bypasses RLS) — seeding + assertions read/write here. */
  readonly db: Kysely<DB>;
  readonly forTenant: ForTenant;
  readonly clock: FakeClock;
  /** Pokes DELIVERED to a subscriber, in order — the real hub fan-out, not a spy on publish. */
  readonly pokes: PokeScope[];
  /** Access-log records in order (default sink; replaced if `overrides.accessLogSink` is given). */
  readonly accessLogs: AccessLogRecord[];
  /** Route keys of handlers that ran (the onStub seam) — a "handler executed" witness. */
  readonly stubCalls: string[];
  readonly tokenStore: InMemoryTokenStore;
  /** The harness's default fake push sender — accepted pushes deliver `sync`/`conflict`/`device`
   *  here (no real Expo, CLAUDE.md §6). Used UNLESS the caller passes `options.pushPort` (e.g. the
   *  latency test's blocking port); when a custom port is given the app sends through THAT and the
   *  caller asserts on its own reference (task 134). */
  readonly pushPort: FakePushPort;
  /** The injected fire-and-forget delivery dispatcher (task 134). Deliveries run OFF the request
   *  path (api/04-push §1/§6); drain them with `await deliveries.flush()` before asserting. */
  readonly deliveries: ImmediateDeliveryDispatcher;
  /** Provenance: which real PostgreSQL database answered (T-14d). */
  readonly provenance: string;
  /** Seed a fresh tenant+store+device+user, enroll its token; returns its chain builder. */
  seedDevice(
    seed: number,
    options?: { readonly deviceStatus?: 'active' | 'revoked' },
  ): Promise<SeededDevice>;
  /** Seed an extra store in an existing tenant; returns its store id. */
  seedStore(tenantId: string, seed: number): Promise<string>;
  /** Seed an extra device (+user) in an existing tenant/store; enroll its token. */
  seedDeviceIn(
    tenantId: string,
    storeId: string | null,
    seed: number,
    options?: { readonly kind?: 'member' | 'system'; readonly status?: 'active' | 'revoked' },
  ): Promise<SeededDevice>;
  /** Revoke a seeded device in place (directory mutation — bumps the devices-directory version). */
  revokeDevice(deviceId: string, at?: number): Promise<void>;
  push(auth: string, deviceId: string, ops: readonly SignedOperation[]): Promise<Response>;
  pull(
    auth: string,
    body: { cursor: number; limit?: number; devicesDirectoryVersion: number },
  ): Promise<Response>;
  close(): Promise<void>;
}

function forTenantOn(db: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      if (role !== undefined) await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

function tokenFor(seed: number): string {
  return `bdt_${seed.toString(16).padStart(32, '0')}`;
}

export async function makeSyncHarness(
  options: {
    readonly registry?: OpRegistry;
    readonly overrides?: Partial<ServerDeps>;
    /** A custom push sender for the app (e.g. a blocking port for the latency probe). Defaults to
     *  the harness's FakePushPort; when set, assert on your own reference, not `h.pushPort`. */
    readonly pushPort?: PushPort;
  } = {},
): Promise<SyncHarness> {
  // Clone this file's own real PG16 database from the pre-migrated template (§2.8 — the seam owns
  // the `pg.Pool` + CamelCasePlugin so `pg` never crosses the boundary). `close` destroys the pool.
  const { db, provenance, close } = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );

  const appForTenant = forTenantOn(db, APP_ROLE);
  const clock = makeFakeClock();
  const tokenStore = new InMemoryTokenStore();
  const pokeHub = new InProcessPokeHub();
  const pokes: PokeScope[] = [];
  pokeHub.subscribe((scope) => pokes.push(scope));
  const accessLogs: AccessLogRecord[] = [];
  const stubCalls: string[] = [];
  const pushPort = new FakePushPort();
  const deliveries = new ImmediateDeliveryDispatcher();

  const app = createApp({
    // A capturing access-log sink + onStub witness by default; caller extras (gzipOnProgress, rate
    // stores, or an explicit accessLogSink/onStub) come next; the sync-critical deps below always
    // win so the harness stays a real end-to-end push/pull surface.
    accessLogSink: (record) => accessLogs.push(record),
    onStub: (key) => stubCalls.push(key),
    ...options.overrides,
    now: () => clock.now(),
    forTenant: appForTenant,
    verifyToken: createVerifyToken({ store: tokenStore, now: () => clock.now() }),
    opRegistry: options.registry ?? testRegistry,
    pokeHub,
    // The app sends through `options.pushPort` when given (e.g. the latency probe's blocking port),
    // else the harness's own fake exposed as `h.pushPort`. Delivery is fire-and-forget through
    // `deliveries`, drained by `flush()` before assertions (task 134).
    pushPort: options.pushPort ?? pushPort,
    deliveryDispatcher: deliveries,
  });

  const createdAt = 1_726_000_000_000n;

  function enroll(world: {
    deviceId: string;
    tenantId: string;
    storeId: string | null;
    status?: 'active' | 'revoked';
  }): string {
    const token = tokenFor(hashSeed(world.deviceId));
    tokenStore.add(token, {
      kind: 'device',
      deviceId: world.deviceId,
      tenantId: world.tenantId,
      storeId: world.storeId,
      deviceStatus: world.status ?? 'active',
    });
    return `Bearer ${token}`;
  }

  async function seedDevice(
    seed: number,
    seedOptions: { readonly deviceStatus?: 'active' | 'revoked' } = {},
  ): Promise<SeededDevice> {
    const world = makeWorld(seed, serverCryptoPort);
    const status = seedOptions.deviceStatus ?? 'active';
    await db
      .insertInto('tenants')
      .values({ id: world.tenantId, name: `tenant-${seed}`, createdAt })
      .execute();
    await db
      .insertInto('tenantOpCounters')
      .values({ tenantId: world.tenantId, nextServerSeq: 1n })
      .execute();
    await db
      .insertInto('stores')
      .values({ id: world.storeId, tenantId: world.tenantId, name: `store-${seed}`, createdAt })
      .execute();
    await db
      .insertInto('devices')
      .values({
        id: world.deviceId,
        tenantId: world.tenantId,
        storeId: world.storeId,
        kind: 'member',
        signingKeyPublic: world.publicKeyB64,
        status,
        ...(status === 'revoked' ? { revokedAt: createdAt } : {}),
        enrolledAt: createdAt,
        lastSeq: 0n,
        lastHash: null,
        lastSyncAt: null,
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: world.userId, tenantId: world.tenantId, name: `user-${seed}`, createdAt })
      .execute();
    const auth = enroll({ ...world, status });
    return { world, auth, builder: new ChainBuilder(world, serverCryptoPort) };
  }

  async function seedStore(tenantId: string, seed: number): Promise<string> {
    const storeId = makeWorld(seed, serverCryptoPort).storeId;
    await db
      .insertInto('stores')
      .values({ id: storeId, tenantId, name: `store-${seed}`, createdAt })
      .execute();
    return storeId;
  }

  async function seedDeviceIn(
    tenantId: string,
    storeId: string | null,
    seed: number,
    seedOptions: {
      readonly kind?: 'member' | 'system';
      readonly status?: 'active' | 'revoked';
    } = {},
  ): Promise<SeededDevice> {
    const base = makeWorld(seed, serverCryptoPort);
    const world: ChainWorld = { ...base, tenantId, storeId: storeId ?? base.storeId };
    const kind = seedOptions.kind ?? 'member';
    const status = seedOptions.status ?? 'active';
    await db
      .insertInto('devices')
      .values({
        id: world.deviceId,
        tenantId,
        storeId: kind === 'system' ? null : storeId,
        kind,
        signingKeyPublic: world.publicKeyB64,
        status,
        ...(status === 'revoked' ? { revokedAt: createdAt } : {}),
        enrolledAt: createdAt,
        lastSeq: 0n,
        lastHash: null,
        lastSyncAt: null,
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: world.userId, tenantId, name: `user-${seed}`, createdAt })
      .execute();
    const auth = enroll({
      deviceId: world.deviceId,
      tenantId,
      storeId: kind === 'system' ? null : storeId,
    });
    // Ops from a store-less device carry storeId null; a member device's ops carry its store.
    const opWorld: ChainWorld = {
      ...world,
      storeId: kind === 'system' ? (null as unknown as string) : (storeId as string),
    };
    return { world: opWorld, auth, builder: new ChainBuilder(opWorld, serverCryptoPort) };
  }

  async function revokeDevice(deviceId: string, at = 1_726_050_000_000): Promise<void> {
    await db
      .updateTable('devices')
      .set({ status: 'revoked', revokedAt: BigInt(at) })
      .where('id', '=', deviceId)
      .execute();
  }

  async function push(
    auth: string,
    deviceId: string,
    ops: readonly SignedOperation[],
  ): Promise<Response> {
    return app.request('http://srv.test/v1/sync/push', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, ops }),
    });
  }

  async function pull(
    auth: string,
    body: { cursor: number; limit?: number; devicesDirectoryVersion: number },
  ): Promise<Response> {
    return app.request('http://srv.test/v1/sync/pull', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return {
    app,
    db,
    forTenant: forTenantOn(db),
    clock,
    pokes,
    accessLogs,
    stubCalls,
    tokenStore,
    seedDevice,
    seedStore,
    seedDeviceIn,
    revokeDevice,
    push,
    pull,
    pushPort,
    deliveries,
    provenance,
    // Drain the fire-and-forget deliveries BEFORE tearing the pool down: a push dispatches its
    // `sync` wake off the request path (task 134), so an accepted push's recipient query can still
    // be in flight at teardown and would otherwise fault against a closed pool. `flush()` is
    // instant with the FakePushPort; a test that injected a blocking port flushes in-body first.
    close: async () => {
      await deliveries.flush();
      await close();
    },
  };
}

/** FNV-1a 32-bit over a string — a stable per-device token seed (no RNG, unique per device id). */
function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
