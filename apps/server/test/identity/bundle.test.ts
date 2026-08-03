// Bundle build — the crown-jewel grants-tuple filtering (§5.2) and verifier minimization (§5.1).
// Fixture-first (T-14b): the store-2-only grant is asserted PRESENT in the DB before its absence
// from the store-1 bundle is believed — an empty directory would pass vacuously.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { DeviceBundleSchema } from '@bolusi/schemas';

import {
  makeIdentityHarness,
  provision,
  roleIdOf,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

const NIL_DEVICE = '00000000-0000-0000-0000-000000000000';
const SALT_B64 = Buffer.alloc(16, 1).toString('base64');
const HASH_B64 = Buffer.alloc(32, 2).toString('base64');

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

interface Provisioned {
  tenantId: string;
  s1: string;
  s2: string;
}

async function twoStoreTenant(): Promise<Provisioned> {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['Store One', 'Store Two'],
    ownerName: 'Owner',
    ownerLogin: `owner-${Date.now()}`,
  });
  return { tenantId: p.tenantId, s1: p.storeIds[0] as string, s2: p.storeIds[1] as string };
}

async function fetchBundle(token: string): Promise<{
  users: Array<{
    id: string;
    status: string;
    grants: Array<{ roleId: string; storeId: string | null }>;
    pinVerifier: unknown;
  }>;
}> {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { bundle: { users: never[] } };
  return body.bundle;
}

test('bundle grants-tuple filtering: a store-2-only grant never reaches the store-1 device', async () => {
  const { tenantId, s1, s2 } = await twoStoreTenant();
  const staffRole = await roleIdOf(h, tenantId, 'staff');
  const mainOwnerRole = await roleIdOf(h, tenantId, 'main_owner');

  // A user in BOTH stores with a store-scoped grant in each + one tenant-wide grant.
  const userId = await seedUser(h, {
    tenantId,
    name: 'Multi',
    storeIds: [s1, s2],
    roleKeys: ['staff'], // → (staff, s1) and (staff, s2)
  });
  await h.idb.db
    .insertInto('userRoles')
    .values({ tenantId, userId, roleId: mainOwnerRole, storeId: null })
    .execute();

  // FIXTURE PRESENCE FIRST (T-14b): the store-2 grant must provably EXIST, else "absent from the
  // store-1 bundle" is vacuous.
  const store2Grant = await h.idb.db
    .selectFrom('userRoles')
    .select(['roleId', 'storeId'])
    .where('userId', '=', userId)
    .where('storeId', '=', s2)
    .execute();
  expect(
    store2Grant,
    'store-2 grant fixture missing — the leak test would be vacuous',
  ).toHaveLength(1);

  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const bundle = await fetchBundle(device.token);
  const multi = bundle.users.find((u) => u.id === userId);
  expect(multi).toBeDefined();

  const grantKeys = multi!.grants.map((g) => `${g.roleId}:${g.storeId ?? 'null'}`).sort();
  // Present: the store-1 grant + the tenant-wide grant.
  expect(grantKeys).toContain(`${staffRole}:${s1}`);
  expect(grantKeys).toContain(`${mainOwnerRole}:null`);
  // ABSENT: the store-2-only grant — the whole point.
  expect(grantKeys).not.toContain(`${staffRole}:${s2}`);
  expect(multi!.grants.some((g) => g.storeId === s2)).toBe(false);
});

test('bundle verifier minimization: active in-store user carries the verifier; deactivated → null; out-of-store user absent', async () => {
  const { tenantId, s1, s2 } = await twoStoreTenant();

  // Active user in store 1 with a verifier.
  const active = await seedUser(h, {
    tenantId,
    name: 'Active',
    storeIds: [s1],
    roleKeys: ['staff'],
  });
  await writeVerifier(active, tenantId);

  // Deactivated user in store 1 with a (stored) verifier — must appear with pinVerifier: null.
  const deactivated = await seedUser(h, {
    tenantId,
    name: 'Gone',
    storeIds: [s1],
    roleKeys: ['staff'],
    status: 'deactivated',
  });
  await writeVerifier(deactivated, tenantId);

  // User only in store 2 — must not appear in the store-1 bundle at all.
  const otherStore = await seedUser(h, {
    tenantId,
    name: 'Elsewhere',
    storeIds: [s2],
    roleKeys: ['staff'],
  });

  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const bundle = await fetchBundle(device.token);

  const activeUser = bundle.users.find((u) => u.id === active);
  expect(activeUser?.status).toBe('active');
  expect(activeUser?.pinVerifier).not.toBeNull();

  const deactivatedUser = bundle.users.find((u) => u.id === deactivated);
  expect(deactivatedUser?.status).toBe('deactivated');
  expect(deactivatedUser?.pinVerifier).toBeNull();

  expect(bundle.users.some((u) => u.id === otherStore)).toBe(false);
});

test('bundle etag flips when a directory mutation affects it', async () => {
  const { tenantId, s1 } = await twoStoreTenant();
  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const first = await etagOf(device.token);

  await seedUser(h, { tenantId, name: 'New', storeIds: [s1], roleKeys: ['staff'] });
  const second = await etagOf(device.token);
  expect(second).not.toBe(first);
});

async function etagOf(token: string): Promise<string> {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { etag: string }).etag;
}

async function writeVerifier(userId: string, tenantId: string): Promise<void> {
  await h.idb.db
    .insertInto('userPinVerifiers')
    .values({
      userId,
      tenantId,
      algo: 'argon2id',
      salt: SALT_B64,
      params: { m: 32768, t: 3, p: 1 } as never,
      hash: HASH_B64,
      asOfTimestamp: 1n,
      asOfDeviceId: NIL_DEVICE,
      asOfSeq: 0n,
    })
    .execute();
}

// ── task 180: the server-emitted bundle round-trips through the CLIENT schema ──────────────────────
// Task 161 made the CLIENT parse the bundle at applyBundle with DeviceBundleSchema (fail-closed), but
// nothing asserted the SERVER emits a bundle that schema accepts. So a bundle the server considers
// valid but the client rejects (a >64-char permission id; a new field; a tightened client bound)
// would pass server CI and only fail at a real device's enrollment. This moves that DETECTION into
// server CI. The emitted permissionsSnapshot carries EVERY permission id (bundle.ts PERMISSIONS.map),
// so the round-trip exercises zPermissionId over the whole permission set — the maximal case.
test('the server-emitted bundle satisfies the client DeviceBundleSchema (task 180)', async () => {
  const { tenantId, s1 } = await twoStoreTenant();
  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${device.token}` },
  });
  expect(res.status).toBe(200);
  const { bundle } = (await res.json()) as { bundle: unknown };

  // FIXTURE PRESENCE FIRST (T-14b): a bundle carrying zero permissions would round-trip vacuously.
  const snapshot = (bundle as { permissionsSnapshot: Array<{ id: string }> }).permissionsSnapshot;
  expect(
    snapshot.length,
    'bundle carries no permissions — the round-trip would be vacuous',
  ).toBeGreaterThan(0);

  const parsed = DeviceBundleSchema.safeParse(bundle);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);

  // FALSIFY (§2.11): the assertion is load-bearing, not a tautology — a permission id one char over
  // the client's 64-cap must make the SAME schema REJECT. This is exactly the drift the server-side
  // length cap (registry.ts, task 180) now prevents from ever reaching a real bundle.
  const drifted = structuredClone(bundle) as { permissionsSnapshot: Array<{ id: string }> };
  const overCapId = `notes.${'a'.repeat(60)}`; // 66 chars > 64
  expect(overCapId.length).toBeGreaterThan(64);
  const firstPerm = drifted.permissionsSnapshot[0];
  expect(firstPerm, 'no permission to mutate — falsify would be vacuous').toBeDefined();
  firstPerm!.id = overCapId;
  expect(DeviceBundleSchema.safeParse(drifted).success).toBe(false);
});
