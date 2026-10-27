// User management (§5.4): LAST_ADMIN_PROTECTED (crown jewel), create validation, and the
// pin-verifier door (§5.3 bounds + greatest-asOf merge). Auth is a control session (the acting
// user is the session user) except where a device + X-Acting-User is needed.
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  makeIdentityHarness,
  provision,
  roleIdOf,
  seedControlSession,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';
import { uuidv7 } from '../../src/uuidv7.js';

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

async function tenant(login = `owner-${Date.now()}-${Math.random()}`) {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['Store One'],
    ownerName: 'Owner',
    ownerLogin: login,
  });
  return { tenantId: p.tenantId, s1: p.storeIds[0] as string, ownerId: p.ownerUserId };
}

function bearer(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

test('LAST_ADMIN_PROTECTED: deactivating the sole active tenant admin → 409, then succeeds with a second admin (I-3)', async () => {
  const { tenantId, ownerId } = await tenant();
  const control = await seedControlSession(h, { tenantId, userId: ownerId });

  const first = await h.app.request(`http://srv.test/v1/users/${ownerId}/deactivate`, {
    method: 'POST',
    headers: bearer(control),
  });
  expect(first.status).toBe(409);
  expect(((await first.json()) as { error: { code: string } }).error.code).toBe(
    'LAST_ADMIN_PROTECTED',
  );

  // Add a second active tenant admin (main_owner tenant-wide), then the same deactivation succeeds.
  await seedUser(h, { tenantId, name: 'Second', storeIds: [], roleKeys: ['main_owner'] });
  const second = await h.app.request(`http://srv.test/v1/users/${ownerId}/deactivate`, {
    method: 'POST',
    headers: bearer(control),
  });
  expect(second.status).toBe(200);
  expect(((await second.json()) as { status: string }).status).toBe('deactivated');
});

test('create: password requires loginIdentifier (422); globally-unique login collision (409); scope must cover storeIds (403) (I-9: loginIdentifier is globally unique across tenants, enforced server-side at creation)', async () => {
  const { tenantId, s1, ownerId } = await tenant();
  const control = await seedControlSession(h, { tenantId, userId: ownerId });
  const staffRole = await roleIdOf(h, tenantId, 'staff');

  // password without loginIdentifier → 422 (Zod refine).
  const noLogin = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(control),
    body: JSON.stringify({
      name: 'X',
      loginIdentifier: null,
      password: 'password12345',
      storeIds: [s1],
      roleIds: [staffRole],
      pinVerifier: null,
    }),
  });
  expect(noLogin.status).toBe(422);

  // A second tenant with a login, then creating a user with the SAME login in tenant 1 → 409.
  const other = await provision(h, {
    tenantName: 'Other',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: 'shared-login',
  });
  expect(other.tenantId).toBeDefined();
  const collide = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(control),
    body: JSON.stringify({
      name: 'Dup',
      loginIdentifier: 'shared-login',
      password: null,
      storeIds: [s1],
      roleIds: [staffRole],
      pinVerifier: null,
    }),
  });
  expect(collide.status).toBe(409);
  expect(((await collide.json()) as { error: { code: string } }).error.code).toBe(
    'LOGIN_IDENTIFIER_TAKEN',
  );

  // A store_owner scoped to store 1 cannot create a user in a DIFFERENT store (scope 403).
  const s2 = uuidv7(h.clock.now());
  await h.idb.db
    .insertInto('stores')
    .values({ id: s2, tenantId, name: 'Store Two', createdAt: 1n })
    .execute();
  const storeOwner = await seedUser(h, {
    tenantId,
    name: 'SO',
    storeIds: [s1],
    roleKeys: ['store_owner'],
  });
  const soControl = await seedControlSession(h, { tenantId, userId: storeOwner });
  const outOfScope = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(soControl),
    body: JSON.stringify({
      name: 'Y',
      loginIdentifier: null,
      password: null,
      storeIds: [s2],
      roleIds: [staffRole],
      pinVerifier: null,
    }),
  });
  expect(outOfScope.status).toBe(403);
});

test('pin-verifier: out-of-bounds params → 422; stale asOf → applied:false; newer asOf → applied:true + etag flips', async () => {
  const { tenantId, s1, ownerId } = await tenant();
  const device = await seedDevice(h, { tenantId, storeId: s1, enrolledBy: ownerId });
  // The acting user (owner) sets THEIR OWN verifier (own change → auth.pin_change). The owner
  // is already in every store from provisioning, so they are usable on this device.
  const url = `http://srv.test/v1/users/${ownerId}/pin-verifier`;
  const hdr = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${device.token}`,
    'X-Acting-User': ownerId,
  };
  const verifier = (asOfTs: number, mKiB = 32768, t = 3) => ({
    algorithm: 'argon2id',
    saltB64: SALT_B64,
    mKiB,
    t,
    p: 1,
    hashB64: HASH_B64,
    asOf: { timestamp: asOfTs, deviceId: NIL_DEVICE, seq: 0 },
  });

  // out-of-bounds mKiB → 422 (DoS guard).
  const oob = await h.app.request(url, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ verifierRef: uuidv7(h.clock.now()), verifier: verifier(1000, 1048576) }),
  });
  expect(oob.status).toBe(422);

  // out-of-bounds t=1 → 422.
  const oobT = await h.app.request(url, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({
      verifierRef: uuidv7(h.clock.now()),
      verifier: verifier(1000, 32768, 1),
    }),
  });
  expect(oobT.status).toBe(422);

  // Apply a verifier at asOf ts=1000.
  const applied1 = await h.app.request(url, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ verifierRef: uuidv7(h.clock.now()), verifier: verifier(1000) }),
  });
  expect(applied1.status).toBe(200);
  expect(((await applied1.json()) as { applied: boolean }).applied).toBe(true);

  // A stale POST (asOf ts=500 < 1000) → applied:false, no change.
  const stale = await h.app.request(url, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ verifierRef: uuidv7(h.clock.now()), verifier: verifier(500) }),
  });
  expect(stale.status).toBe(200);
  expect(((await stale.json()) as { applied: boolean }).applied).toBe(false);

  const etagBefore = await bundleEtag(device.token);
  // A newer POST (asOf ts=2000 > 1000) → applied:true, and the bundle etag flips.
  const newer = await h.app.request(url, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({
      verifierRef: uuidv7(h.clock.now()),
      verifier: { ...verifier(2000), hashB64: Buffer.alloc(32, 9).toString('base64') },
    }),
  });
  expect(newer.status).toBe(200);
  expect(((await newer.json()) as { applied: boolean }).applied).toBe(true);
  const etagAfter = await bundleEtag(device.token);
  expect(etagAfter).not.toBe(etagBefore);
});

test('pin-verifier reset of another user without auth.user_reset_pin → 403', async () => {
  const { tenantId, s1 } = await tenant();
  // A staff user (no user_reset_pin) acting on a device, resetting ANOTHER user's PIN.
  const staff = await seedUser(h, { tenantId, name: 'Staff', storeIds: [s1], roleKeys: ['staff'] });
  const victim = await seedUser(h, {
    tenantId,
    name: 'Victim',
    storeIds: [s1],
    roleKeys: ['staff'],
  });
  const device = await seedDevice(h, { tenantId, storeId: s1 });

  const res = await h.app.request(`http://srv.test/v1/users/${victim}/pin-verifier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${device.token}`,
      'X-Acting-User': staff,
    },
    body: JSON.stringify({
      verifierRef: uuidv7(h.clock.now()),
      verifier: {
        algorithm: 'argon2id',
        saltB64: SALT_B64,
        mKiB: 32768,
        t: 3,
        p: 1,
        hashB64: HASH_B64,
        asOf: { timestamp: 1, deviceId: NIL_DEVICE, seq: 0 },
      },
    }),
  });
  expect(res.status).toBe(403);
});

async function bundleEtag(token: string): Promise<string> {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { etag: string }).etag;
}

function verifierBody() {
  return JSON.stringify({
    verifierRef: uuidv7(h.clock.now()),
    verifier: {
      algorithm: 'argon2id',
      saltB64: SALT_B64,
      mKiB: 32768,
      t: 3,
      p: 1,
      hashB64: HASH_B64,
      asOf: { timestamp: 1000, deviceId: NIL_DEVICE, seq: 0 },
    },
  });
}

test('a deactivated user cannot set their own PIN verifier on a device', async () => {
  // Falsification: the own-change path used to skip every check, so this returned 200.
  const { tenantId, s1 } = await tenant();
  const former = await seedUser(h, {
    tenantId,
    name: 'Former',
    status: 'deactivated',
    storeIds: [s1],
    roleKeys: ['staff'],
  });
  const active = await seedUser(h, {
    tenantId,
    name: 'Active',
    storeIds: [s1],
    roleKeys: ['staff'],
  });
  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const post = (userId: string) =>
    h.app.request(`http://srv.test/v1/users/${userId}/pin-verifier`, {
      method: 'POST',
      headers: { ...bearer(device.token), 'X-Acting-User': userId },
      body: verifierBody(),
    });

  expect((await post(former)).status).toBe(403);
  // Positive control: an active staff member sets their own.
  expect((await post(active)).status).toBe(200);
});

test('a user with no store can only be edited or deactivated by a tenant-wide holder', async () => {
  // Falsification: the per-store loop ran zero times for a store-less target and allowed anyone.
  const { tenantId, s1, ownerId } = await tenant();
  const storeless = await seedUser(h, {
    tenantId,
    name: 'Second owner',
    storeIds: [],
    roleKeys: ['main_owner'],
  });
  const storeOwner = await seedUser(h, {
    tenantId,
    name: 'Store owner',
    storeIds: [s1],
    roleKeys: ['store_owner'],
  });
  const asStoreOwner = await seedControlSession(h, { tenantId, userId: storeOwner });
  const asMainOwner = await seedControlSession(h, { tenantId, userId: ownerId });

  const rename = (token: string) =>
    h.app.request(`http://srv.test/v1/users/${storeless}`, {
      method: 'PATCH',
      headers: bearer(token),
      body: JSON.stringify({ name: 'Renamed' }),
    });
  const deactivate = (token: string) =>
    h.app.request(`http://srv.test/v1/users/${storeless}/deactivate`, {
      method: 'POST',
      headers: bearer(token),
    });

  expect((await rename(asStoreOwner)).status).toBe(403);
  expect((await deactivate(asStoreOwner)).status).toBe(403);
  expect((await rename(asMainOwner)).status).toBe(200);
  expect((await deactivate(asMainOwner)).status).toBe(200);
});

// ── Owner powers (owner decision 2026-10-27, thread "Let owners add employees in the app") ────────
// A store owner adds and manages cashiers and technicians of their own store, from a store device;
// only the main owner may make, change or remove an owner.

async function storeWithOwners() {
  const { tenantId, s1, ownerId } = await tenant();
  const storeOwner = await seedUser(h, {
    tenantId,
    name: 'Store Owner',
    storeIds: [s1],
    roleKeys: ['store_owner'],
  });
  const device = await seedDevice(h, { tenantId, storeId: s1, enrolledBy: ownerId });
  const as = (userId: string) => ({ ...bearer(device.token), 'X-Acting-User': userId });
  return {
    tenantId,
    s1,
    ownerId,
    storeOwner,
    as,
    cashier: await roleIdOf(h, tenantId, 'cashier'),
    technician: await roleIdOf(h, tenantId, 'technician'),
    storeOwnerRole: await roleIdOf(h, tenantId, 'store_owner'),
    mainOwnerRole: await roleIdOf(h, tenantId, 'main_owner'),
  };
}

async function grantsOf(userId: string) {
  const rows = await h.idb.db
    .selectFrom('userRoles')
    .innerJoin('roles', 'roles.id', 'userRoles.roleId')
    .select(['roles.name', 'userRoles.storeId'])
    .where('userRoles.userId', '=', userId)
    .execute();
  return rows.map((r) => `${r.name}@${r.storeId ?? 'tenant'}`).sort();
}

function newStaff(storeId: string, roleIds: string[]) {
  return JSON.stringify({
    name: 'Rina',
    loginIdentifier: null,
    password: null,
    storeIds: [storeId],
    roleIds,
    pinVerifier: null,
  });
}

test('a store owner adds a cashier-technician from a store device, but never another owner', async () => {
  const s = await storeWithOwners();

  const created = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: s.as(s.storeOwner),
    body: newStaff(s.s1, [s.cashier, s.technician]),
  });
  expect(created.status).toBe(201);
  const { userId } = (await created.json()) as { userId: string };
  expect(await grantsOf(userId)).toEqual([`cashier@${s.s1}`, `technician@${s.s1}`]);

  for (const roleIds of [[s.storeOwnerRole], [s.cashier, s.storeOwnerRole], [s.mainOwnerRole]]) {
    const refused = await h.app.request('http://srv.test/v1/users', {
      method: 'POST',
      headers: s.as(s.storeOwner),
      body: newStaff(s.s1, roleIds),
    });
    expect(refused.status).toBe(403);
  }

  // The main owner may add a store owner.
  const owner = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: s.as(s.ownerId),
    body: newStaff(s.s1, [s.storeOwnerRole]),
  });
  expect(owner.status).toBe(201);
});

test('changing roles replaces every grant, and a store owner cannot promote anyone to owner', async () => {
  const s = await storeWithOwners();
  const rina = await seedUser(h, {
    tenantId: s.tenantId,
    name: 'Rina',
    storeIds: [s.s1],
    roleKeys: ['cashier'],
  });

  const changed = await h.app.request(`http://srv.test/v1/users/${rina}`, {
    method: 'PATCH',
    headers: s.as(s.storeOwner),
    body: JSON.stringify({ name: 'Rina Wati', roleIds: [s.technician] }),
  });
  expect(changed.status).toBe(200);
  expect(await grantsOf(rina)).toEqual([`technician@${s.s1}`]);
  const row = await h.idb.db
    .selectFrom('users')
    .select('name')
    .where('id', '=', rina)
    .executeTakeFirstOrThrow();
  expect(row.name).toBe('Rina Wati');

  const promote = await h.app.request(`http://srv.test/v1/users/${rina}`, {
    method: 'PATCH',
    headers: s.as(s.storeOwner),
    body: JSON.stringify({ roleIds: [s.storeOwnerRole] }),
  });
  expect(promote.status).toBe(403);
  expect(await grantsOf(rina)).toEqual([`technician@${s.s1}`]);

  // A role id from nowhere is a denial, not a silent drop.
  const unknown = await h.app.request(`http://srv.test/v1/users/${rina}`, {
    method: 'PATCH',
    headers: s.as(s.storeOwner),
    body: JSON.stringify({ roleIds: [uuidv7(h.clock.now())] }),
  });
  expect(unknown.status).toBe(403);
});

test('a store owner cannot rename, re-role, deactivate or reactivate a peer owner; the main owner can', async () => {
  const s = await storeWithOwners();
  const peer = await seedUser(h, {
    tenantId: s.tenantId,
    name: 'Peer Owner',
    storeIds: [s.s1],
    roleKeys: ['store_owner'],
  });

  const attempts: [string, string, string | undefined][] = [
    ['PATCH', `/v1/users/${peer}`, JSON.stringify({ name: 'X' })],
    ['PATCH', `/v1/users/${peer}`, JSON.stringify({ roleIds: [s.cashier] })],
    ['POST', `/v1/users/${peer}/deactivate`, undefined],
    ['POST', `/v1/users/${peer}/reactivate`, undefined],
    ['POST', `/v1/users/${s.ownerId}/deactivate`, undefined],
  ];
  for (const [method, path, body] of attempts) {
    const res = await h.app.request(`http://srv.test${path}`, {
      method,
      headers: s.as(s.storeOwner),
      ...(body === undefined ? {} : { body }),
    });
    expect(res.status, `${method} ${path}`).toBe(403);
  }

  const byMain = await h.app.request(`http://srv.test/v1/users/${peer}/deactivate`, {
    method: 'POST',
    headers: s.as(s.ownerId),
  });
  expect(byMain.status).toBe(200);
});

test('a store owner deactivates and reactivates a cashier of their store', async () => {
  const s = await storeWithOwners();
  const rina = await seedUser(h, {
    tenantId: s.tenantId,
    name: 'Rina',
    storeIds: [s.s1],
    roleKeys: ['cashier'],
  });
  for (const [path, status] of [
    ['deactivate', 'deactivated'],
    ['reactivate', 'active'],
  ] as const) {
    const res = await h.app.request(`http://srv.test/v1/users/${rina}/${path}`, {
      method: 'POST',
      headers: s.as(s.storeOwner),
    });
    expect(res.status).toBe(200);
    const row = await h.idb.db
      .selectFrom('users')
      .select('status')
      .where('id', '=', rina)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe(status);
  }
});

test('LAST_ADMIN_PROTECTED: taking the last main owner role away is refused', async () => {
  const s = await storeWithOwners();
  const res = await h.app.request(`http://srv.test/v1/users/${s.ownerId}`, {
    method: 'PATCH',
    headers: s.as(s.ownerId),
    body: JSON.stringify({ roleIds: [s.storeOwnerRole] }),
  });
  expect(res.status).toBe(409);
  expect(await grantsOf(s.ownerId)).toEqual(['main_owner@tenant']);
});

test('a custom role with any power over accounts counts as an owner role, not just user_create', async () => {
  const s = await storeWithOwners();
  const roleId = uuidv7(h.clock.now());
  await h.idb.db
    .insertInto('roles')
    .values({
      id: roleId,
      tenantId: s.tenantId,
      name: 'supervisor',
      scopeType: 'store',
      isSystemDefault: false,
      createdAt: 1n,
    })
    .execute();
  await h.idb.db
    .insertInto('rolePermissions')
    .values({ roleId, permissionId: 'auth.user_deactivate', tenantId: s.tenantId })
    .execute();

  const refused = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: s.as(s.storeOwner),
    body: newStaff(s.s1, [s.cashier, roleId]),
  });
  expect(refused.status).toBe(403);
});
