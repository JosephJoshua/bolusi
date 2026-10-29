// The api/02-auth §9 tenant-wide budgets (revoke, enroll, users) are charged only AFTER the caller
// is authorised. Charged first, a caller who may not perform the action could spend the tenant's
// whole budget with refused calls and lock the owner out of the same action — worst for revoke,
// where the refused caller is a stolen phone and the locked-out action is revoking it.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { IDENTITY_LIMITS } from '../../src/identity/rate-limits.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  login,
  makeIdentityHarness,
  provision,
  roleIdOf,
  seedControlSession,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

const PASSWORD = 'Owner1PasswordBase58xyz9';
const BASE = 'http://srv.test';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

async function setup() {
  const ownerLogin = `o-${Math.random()}`;
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'Owner',
    ownerLogin,
  });
  return { p, ownerLogin, storeId: p.storeIds[0] as string };
}

test('refused revokes from a stolen device do not spend the budget the owner needs to revoke it', async () => {
  const { p, storeId } = await setup();
  const stolen = await seedDevice(h, { tenantId: p.tenantId, storeId });

  // No X-Acting-User at all: every call is refused before it may revoke anything.
  for (let i = 0; i <= IDENTITY_LIMITS.revokePerTenantHour.limit; i += 1) {
    const r = await h.app.request(`${BASE}/v1/devices/${uuidv7(h.clock.now())}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stolen.token}` },
    });
    expect(r.status).toBe(403);
  }

  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  const res = await h.app.request(`${BASE}/v1/devices/${stolen.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(res.status).toBe(200);
});

test('an authorised revoke still charges the tenant revoke budget', async () => {
  const { p, storeId } = await setup();
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  const revoke = async () => {
    const d = await seedDevice(h, { tenantId: p.tenantId, storeId });
    return h.app.request(`${BASE}/v1/devices/${d.deviceId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${control}` },
    });
  };
  for (let i = 0; i < IDENTITY_LIMITS.revokePerTenantHour.limit; i += 1) {
    expect((await revoke()).status).toBe(200);
  }
  expect((await revoke()).status).toBe(429);
});

test('a cashier cannot burn the tenant user-management quota with refused calls', async () => {
  const { p, storeId } = await setup();
  const cashier = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Kasir',
    storeIds: [storeId],
    roleKeys: ['cashier'],
  });
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId });

  for (let i = 0; i <= IDENTITY_LIMITS.usersPerTenantDay.limit; i += 1) {
    const r = await h.app.request(`${BASE}/v1/users/${p.ownerUserId}/deactivate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${device.token}`, 'X-Acting-User': cashier },
    });
    expect(r.status).toBe(403);
  }

  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  const res = await h.app.request(`${BASE}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control}` },
    body: JSON.stringify({
      name: 'New tech',
      loginIdentifier: null,
      password: null,
      storeIds: [storeId],
      roleIds: [await roleIdOf(h, p.tenantId, 'technician')],
      pinVerifier: null,
    }),
  });
  expect(res.status).toBe(201);
});

test('a session without auth.device_enroll cannot burn the tenant enrolment budget', async () => {
  const { p, ownerLogin, storeId } = await setup();
  await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Kasir',
    loginIdentifier: 'kasir-enroll',
    passwordVerifier: await h.kdf.createVerifier(PASSWORD),
    storeIds: [storeId],
    roleKeys: ['cashier'],
  });
  const cashierSession = (await login(h, 'kasir-enroll', PASSWORD)).body[
    'controlSession'
  ] as string;
  const body = (i: number) => ({
    deviceId: uuidv7(h.clock.now() + i),
    devicePublicKeyB64: Buffer.alloc(32, (i % 250) + 1).toString('base64'),
    storeId,
    deviceName: `d${i}`,
    platform: 'android',
    appVersion: '1',
  });
  for (let i = 0; i <= IDENTITY_LIMITS.enrollPerTenantDay.limit; i += 1) {
    expect((await enroll(h, cashierSession, body(i), `k-${i}`)).status).toBe(403);
  }

  const ownerSession = (await login(h, ownerLogin, PASSWORD)).body['controlSession'] as string;
  expect((await enroll(h, ownerSession, body(99), 'owner-key')).status).toBe(201);
});
