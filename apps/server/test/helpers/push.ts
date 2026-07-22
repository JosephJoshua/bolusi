// Push integration harness: a real PostgreSQL 16 DB (cloned per file, RLS-aware forTenant), the real
// production `createApp` wired to it, and deterministic seeders + request builders for the
// `POST /v1/push/tokens` endpoint and the fan-out triggers. Seeding uses the OWNER handle (bypasses
// RLS — what a fixture needs); the app under test uses `appForTenant` (SET LOCAL ROLE bolusi_app →
// RLS enforced), so the tenant-isolation probes are non-vacuous (testing-guide §2.5, T-14b).
//
// The DB helper is the generic real-PG tenant DB (`makeMediaTestDb` — generic despite its name; it
// returns db/appForTenant/ownerForTenant and nothing media-specific), reused rather than copied
// (CLAUDE.md §2.8).
import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { DB } from '@bolusi/db-server';

import { enrollDevice, makeTestApp, type TestHarness } from './app.js';
import { makeMediaTestDb, type MediaTestDb } from './media-db.js';

// ── deterministic ids (per-seed, no RNG — testing-guide T-6) ─────────────────────────────────────
function seedBytes(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

/** A valid lowercase RFC 4122 v4 UUID from `seed` (tenant/store/device/user/conflict ids). */
export function detUuid(seed: string): string {
  const b = Buffer.from(seedBytes(seed).subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The canonical Expo token shape for a seed. */
export function expoToken(seed: string): string {
  return `ExponentPushToken[${seedBytes(seed).toString('hex').slice(0, 22)}]`;
}

export interface DeviceContext {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly deviceId: string;
  readonly userId: string;
  readonly bearerToken: string;
  readonly auth: string;
}

export interface PushHarness extends TestHarness {
  readonly db: Kysely<DB>;
  readonly testDb: MediaTestDb;
  /** Seed a tenant + store + device + user (owner handle) and enroll the device bearer token. */
  seedDevice(
    seed: string,
    opts?: { storeId?: string | null; tenantId?: string },
  ): Promise<DeviceContext>;
  /** Seed a second device (+ user) into an EXISTING tenant/store, enroll its bearer. */
  seedDeviceInTenant(
    seed: string,
    tenant: { tenantId: string; storeId: string | null },
  ): Promise<DeviceContext>;
  /** Seed a store into a tenant (owner handle). */
  seedStore(tenantId: string, seed: string): Promise<string>;
  /** Insert a `push_tokens` row directly (owner handle) — for fan-out fixtures. */
  seedPushToken(row: {
    tenantId: string;
    deviceId: string;
    userId?: string | null;
    token?: string;
  }): Promise<void>;
  /** Insert/replace a `user_prefs` row (owner handle). */
  seedUserPrefs(row: { userId: string; tenantId: string; locale: string }): Promise<void>;
  /** Grant `auth.device_read` to a user in a store (seeds role + role_permission + user_role). */
  grantDeviceRead(row: { tenantId: string; userId: string; storeId: string | null }): Promise<void>;
  /** Insert a `surfaced` conflict row (owner handle). Returns the conflict id. */
  seedConflict(row: { tenantId: string; storeId: string | null; seed: string }): Promise<string>;
  /** Revoke a device (owner handle) — status flip only (the delete-on-revoke path is revoke.test). */
  revokeDevice(deviceId: string): Promise<void>;
  /** Count push-token rows for a device (owner handle). */
  countTokens(deviceId: string): Promise<number>;
  close(): Promise<void>;
}

export async function makePushHarness(): Promise<PushHarness> {
  const testDb = await makeMediaTestDb();
  const harness = makeTestApp({ forTenant: testDb.appForTenant });
  const db = testDb.db;

  async function seedStore(tenantId: string, seed: string): Promise<string> {
    const storeId = detUuid(`${seed}:store`);
    await db
      .insertInto('stores')
      .values({ id: storeId, tenantId, name: `store-${seed}`, createdAt: 1 })
      .execute();
    return storeId;
  }

  async function insertDevice(
    seed: string,
    tenantId: string,
    storeId: string | null,
  ): Promise<DeviceContext> {
    const deviceId = detUuid(`${seed}:device`);
    const userId = detUuid(`${seed}:user`);
    const bearerToken = `bdt_${seedBytes(`${seed}:tok`).toString('hex')}`;
    await db
      .insertInto('devices')
      .values({
        id: deviceId,
        tenantId,
        storeId,
        kind: storeId === null ? 'system' : 'member',
        signingKeyPublic: `pub-${seed}`,
        enrolledAt: 1,
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: userId, tenantId, name: `user-${seed}`, status: 'active', createdAt: 1 })
      .execute();
    const auth = enrollDevice(harness, { deviceId, tenantId, storeId, token: bearerToken });
    return { tenantId, storeId, deviceId, userId, bearerToken, auth };
  }

  async function seedDevice(
    seed: string,
    opts: { storeId?: string | null; tenantId?: string } = {},
  ): Promise<DeviceContext> {
    const tenantId = opts.tenantId ?? detUuid(`${seed}:tenant`);
    await db
      .insertInto('tenants')
      .values({ id: tenantId, name: `tenant-${seed}`, createdAt: 1 })
      .execute();
    const storeId = opts.storeId === undefined ? detUuid(`${seed}:store`) : opts.storeId;
    if (storeId !== null) {
      await db
        .insertInto('stores')
        .values({ id: storeId, tenantId, name: `store-${seed}`, createdAt: 1 })
        .execute();
    }
    return insertDevice(seed, tenantId, storeId);
  }

  return {
    ...harness,
    db,
    testDb,
    seedDevice,
    seedDeviceInTenant: (seed, tenant) => insertDevice(seed, tenant.tenantId, tenant.storeId),
    seedStore,
    async seedPushToken(row) {
      await db
        .insertInto('pushTokens')
        .values({
          id: detUuid(`pt:${row.deviceId}`),
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          userId: row.userId ?? null,
          expoPushToken: row.token ?? expoToken(`tok:${row.deviceId}`),
          updatedAt: 1,
        })
        .execute();
    },
    async seedUserPrefs(row) {
      await db
        .insertInto('userPrefs')
        .values({ userId: row.userId, tenantId: row.tenantId, locale: row.locale, updatedAt: 1 })
        .onConflict((oc) => oc.column('userId').doUpdateSet({ locale: row.locale, updatedAt: 1 }))
        .execute();
    },
    async grantDeviceRead(row) {
      const roleId = detUuid(`role:${row.userId}:${row.storeId ?? 'tenant'}`);
      await db
        .insertInto('roles')
        .values({
          id: roleId,
          tenantId: row.tenantId,
          name: `owner-${roleId.slice(0, 6)}`,
          scopeType: 'store',
          createdAt: 1,
        })
        .execute();
      await db
        .insertInto('rolePermissions')
        .values({ tenantId: row.tenantId, roleId, permissionId: 'auth.device_read' })
        .execute();
      await db
        .insertInto('userRoles')
        .values({ tenantId: row.tenantId, userId: row.userId, roleId, storeId: row.storeId })
        .execute();
    },
    async seedConflict(row) {
      const id = detUuid(`conflict:${row.seed}`);
      await db
        .insertInto('conflicts')
        .values({
          id,
          tenantId: row.tenantId,
          storeId: row.storeId,
          entityType: 'note',
          entityId: detUuid(`entity:${row.seed}`),
          conflictKey: `k:${row.seed}`,
          severity: 'significant',
          status: 'surfaced',
          opAId: detUuid(`opa:${row.seed}`),
          opBId: detUuid(`opb:${row.seed}`),
          detectedAt: 1,
        })
        .execute();
      return id;
    },
    async revokeDevice(deviceId) {
      await db
        .updateTable('devices')
        .set({ status: 'revoked', revokedAt: 2 })
        .where('id', '=', deviceId)
        .execute();
    },
    async countTokens(deviceId) {
      const rows = await db
        .selectFrom('pushTokens')
        .select('id')
        .where('deviceId', '=', deviceId)
        .execute();
      return rows.length;
    },
    async close() {
      // Drain fire-and-forget deliveries before the pool closes (task 134) — a dispatched alert's
      // recipient query must not fault against a torn-down pool.
      await harness.deliveries.flush();
      await testDb.close();
    },
  };
}

// ── request builders ────────────────────────────────────────────────────────────────────────────
const BASE = 'http://push.test';

export function registerReq(
  body: unknown,
  opts: { auth?: string; actingUser?: string } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== undefined) headers['Authorization'] = opts.auth;
  if (opts.actingUser !== undefined) headers['X-Acting-User'] = opts.actingUser;
  return new Request(`${BASE}/v1/push/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
