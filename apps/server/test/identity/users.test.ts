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
    asOf: { timestamp: asOfTs, deviceId: device.deviceId, seq: 0 },
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

// The greatest-asOf merge trusts `asOf`, so an unbounded one let a single reset beat every later
// reset — a store owner could pin a cashier's PIN against even the main owner.
test('pin-verifier: an asOf ahead of the server clock or from another device is refused (422) and later resets still apply', async () => {
  const { tenantId, s1, ownerId } = await tenant();
  const storeOwner = await seedUser(h, {
    tenantId,
    name: 'SO',
    storeIds: [s1],
    roleKeys: ['store_owner'],
  });
  const cashier = await seedUser(h, {
    tenantId,
    name: 'Kasir',
    storeIds: [s1],
    roleKeys: ['cashier'],
  });
  const device = await seedDevice(h, { tenantId, storeId: s1 });
  const post = (actor: string, asOf: { timestamp: number; deviceId: string; seq: number }) =>
    h.app.request(`http://srv.test/v1/users/${cashier}/pin-verifier`, {
      method: 'POST',
      headers: { ...bearer(device.token), 'X-Acting-User': actor },
      body: JSON.stringify({
        verifierRef: uuidv7(h.clock.now()),
        verifier: {
          algorithm: 'argon2id',
          saltB64: SALT_B64,
          mKiB: 32768,
          t: 3,
          p: 1,
          hashB64: HASH_B64,
          asOf,
        },
      }),
    });
  const now = h.clock.now();

  const farFuture = await post(storeOwner, {
    timestamp: Number.MAX_SAFE_INTEGER,
    deviceId: device.deviceId,
    seq: 0,
  });
  expect(farFuture.status).toBe(422);
  const justAhead = await post(storeOwner, {
    timestamp: now + 10 * 60 * 1000 + 1,
    deviceId: device.deviceId,
    seq: 0,
  });
  expect(justAhead.status).toBe(422);
  const otherDevice = await post(storeOwner, { timestamp: now, deviceId: NIL_DEVICE, seq: 0 });
  expect(otherDevice.status).toBe(422);

  // Within the clock margin on the posting device: accepted, and a later reset still wins over it.
  const ahead = await post(storeOwner, {
    timestamp: now + 10 * 60 * 1000,
    deviceId: device.deviceId,
    seq: 0,
  });
  expect(((await ahead.json()) as { applied: boolean }).applied).toBe(true);
  h.clock.advance(10 * 60 * 1000 + 1);
  const later = await post(ownerId, {
    timestamp: h.clock.now(),
    deviceId: device.deviceId,
    seq: 1,
  });
  expect(later.status).toBe(200);
  expect(((await later.json()) as { applied: boolean }).applied).toBe(true);
});

test('create: a pinVerifier asOf ahead of the server clock is refused (422)', async () => {
  const { tenantId, s1, ownerId } = await tenant();
  const control = await seedControlSession(h, { tenantId, userId: ownerId });
  const res = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(control),
    body: JSON.stringify({
      name: 'Tech',
      loginIdentifier: null,
      password: null,
      storeIds: [s1],
      roleIds: [await roleIdOf(h, tenantId, 'technician')],
      pinVerifier: {
        algorithm: 'argon2id',
        saltB64: SALT_B64,
        mKiB: 32768,
        t: 3,
        p: 1,
        hashB64: HASH_B64,
        asOf: { timestamp: Number.MAX_SAFE_INTEGER, deviceId: NIL_DEVICE, seq: 0 },
      },
    }),
  });
  expect(res.status).toBe(422);
});

async function bundleEtag(token: string): Promise<string> {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { etag: string }).etag;
}

function verifierBody(deviceId: string) {
  return JSON.stringify({
    verifierRef: uuidv7(h.clock.now()),
    verifier: {
      algorithm: 'argon2id',
      saltB64: SALT_B64,
      mKiB: 32768,
      t: 3,
      p: 1,
      hashB64: HASH_B64,
      asOf: { timestamp: 1000, deviceId, seq: 0 },
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
      body: verifierBody(device.deviceId),
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

test('every staff change pokes the whole tenant so other phones pull it now; a refusal pokes nobody', async () => {
  const s = await storeWithOwners();
  const tenantPoke = { tenantId: s.tenantId, storeId: null };
  const pokesAfter = async (
    request: Response | Promise<Response>,
    status: number,
  ): Promise<number> => {
    const before = h.pokes.length;
    expect((await request).status).toBe(status);
    return h.pokes.length - before;
  };

  const created = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: s.as(s.storeOwner),
    body: newStaff(s.s1, [s.cashier]),
  });
  expect(created.status).toBe(201);
  expect(h.pokes.at(-1)).toEqual(tenantPoke);
  const { userId } = (await created.json()) as { userId: string };

  const patch = (body: object) =>
    h.app.request(`http://srv.test/v1/users/${userId}`, {
      method: 'PATCH',
      headers: s.as(s.storeOwner),
      body: JSON.stringify(body),
    });
  const post = (path: string) =>
    h.app.request(`http://srv.test/v1/users/${userId}/${path}`, {
      method: 'POST',
      headers: s.as(s.storeOwner),
    });

  expect(await pokesAfter(patch({ roleIds: [s.technician] }), 200)).toBe(1);
  expect(await pokesAfter(post('deactivate'), 200)).toBe(1);
  expect(await pokesAfter(post('reactivate'), 200)).toBe(1);
  expect(h.pokes.at(-1)).toEqual(tenantPoke);

  // Refused: a store owner may not make an owner. Nothing changed, so nothing is announced.
  expect(await pokesAfter(patch({ roleIds: [s.storeOwnerRole] }), 403)).toBe(0);
});

async function twoStores() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['A', 'B'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const [storeA, storeB] = p.storeIds as [string, string];
  const storeOwner = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'SO',
    storeIds: [storeA],
    roleKeys: ['store_owner'],
  });
  const addCashierAt = async (token: string, storeId: string) =>
    h.app.request('http://srv.test/v1/users', {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        name: 'Planted',
        loginIdentifier: null,
        password: null,
        pinVerifier: null,
        storeIds: [storeId],
        roleIds: [await roleIdOf(h, p.tenantId, 'cashier')],
      }),
    });
  return { ...p, storeA, storeB, storeOwner, addCashierAt };
}

test('moving a store owner to another store takes their owner powers at the old store away', async () => {
  const s = await twoStores();
  const mainOwner = await seedControlSession(h, { tenantId: s.tenantId, userId: s.ownerUserId });

  const moved = await h.app.request(`http://srv.test/v1/users/${s.storeOwner}`, {
    method: 'PATCH',
    headers: bearer(mainOwner),
    body: JSON.stringify({ storeIds: [s.storeB] }),
  });
  expect(moved.status).toBe(200);
  const grants = await h.idb.db
    .selectFrom('userRoles')
    .select(['roleId', 'storeId'])
    .where('userId', '=', s.storeOwner)
    .execute();
  expect(grants).toStrictEqual([
    { roleId: await roleIdOf(h, s.tenantId, 'store_owner'), storeId: s.storeB },
  ]);

  const token = await seedControlSession(h, { tenantId: s.tenantId, userId: s.storeOwner });
  const limits = await h.app.request('http://srv.test/v1/role-limits', {
    method: 'PUT',
    headers: bearer(token),
    body: JSON.stringify({
      storeId: s.storeA,
      roleId: await roleIdOf(h, s.tenantId, 'manager'),
      priceDrop: 9_000_000,
      refund: 9_000_000,
      credit: 9_000_000,
    }),
  });
  expect(limits.status).toBe(403);
  expect((await s.addCashierAt(token, s.storeA)).status).toBe(403);
  expect((await s.addCashierAt(token, s.storeB)).status).toBe(201);
});

test('a grant left at a store the person no longer belongs to grants nothing there', async () => {
  const s = await twoStores();
  // Membership moved without its grant, as PATCH left it before grants followed store moves.
  await h.idb.db
    .updateTable('userStores')
    .set({ storeId: s.storeB })
    .where('userId', '=', s.storeOwner)
    .execute();
  const token = await seedControlSession(h, { tenantId: s.tenantId, userId: s.storeOwner });
  expect((await s.addCashierAt(token, s.storeA)).status).toBe(403);
});

test("a store owner cannot reset a peer owner's PIN; they can reset a cashier's, and the main owner a store owner's", async () => {
  const s = await storeWithOwners();
  const peer = await seedUser(h, {
    tenantId: s.tenantId,
    name: 'Peer Owner',
    storeIds: [s.s1],
    roleKeys: ['store_owner'],
  });
  const cashier = await seedUser(h, {
    tenantId: s.tenantId,
    name: 'Cashier',
    storeIds: [s.s1],
    roleKeys: ['cashier'],
  });
  const reset = (actor: string, target: string) =>
    h.app.request(`http://srv.test/v1/users/${target}/pin-verifier`, {
      method: 'POST',
      headers: s.as(actor),
      body: verifierBody(),
    });

  expect((await reset(s.storeOwner, peer)).status).toBe(403);
  expect((await reset(s.storeOwner, s.ownerId)).status).toBe(403);
  expect((await reset(s.storeOwner, cashier)).status).toBe(200);
  expect((await reset(s.ownerId, peer)).status).toBe(200);
});
