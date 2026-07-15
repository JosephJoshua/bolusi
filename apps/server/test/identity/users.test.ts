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

test('LAST_ADMIN_PROTECTED: deactivating the sole active tenant admin → 409, then succeeds with a second admin', async () => {
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

test('create: password requires loginIdentifier (422); globally-unique login collision (409); scope must cover storeIds (403)', async () => {
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
  // The acting user (owner) sets THEIR OWN verifier (own change → no permission needed). The owner
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
