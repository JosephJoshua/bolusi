// PATCH /v1/devices/me: an owner signed in on a device renames it; anyone else is refused.
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  makeIdentityHarness,
  provision,
  seedControlSession,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const storeId = p.storeIds[0] as string;
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });
  return { p, storeId, device };
}

function rename(token: string, body: unknown, actingUser?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (actingUser !== undefined) headers['X-Acting-User'] = actingUser;
  return h.app.request('http://srv.test/v1/devices/me', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function nameOf(deviceId: string): Promise<string> {
  const row = await h.idb.db
    .selectFrom('devices')
    .select('name')
    .where('id', '=', deviceId)
    .executeTakeFirstOrThrow();
  return row.name;
}

test('an owner renames the device they are signed in on; the name is trimmed and audited', async () => {
  const { p, device } = await setup();

  const res = await rename(device.token, { deviceName: '  Kasir depan  ' }, p.ownerUserId);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deviceId: device.deviceId, deviceName: 'Kasir depan' });
  expect(await nameOf(device.deviceId)).toBe('Kasir depan');

  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .selectAll()
    .where('action', '=', 'device.renamed')
    .where('entityId', '=', device.deviceId)
    .execute();
  expect(audit).toHaveLength(1);
  expect(audit[0]?.actorUserId).toBe(p.ownerUserId);
  expect(audit[0]?.after).toEqual({ deviceName: 'Kasir depan' });

  // The same name again changes nothing and writes no second audit row.
  expect((await rename(device.token, { deviceName: 'Kasir depan' }, p.ownerUserId)).status).toBe(
    200,
  );
  const again = await h.idb.db
    .selectFrom('identityAudit')
    .select('id')
    .where('action', '=', 'device.renamed')
    .execute();
  expect(again).toHaveLength(1);
});

test('someone without device registration rights at the store is refused and nothing changes', async () => {
  const { p, storeId, device } = await setup();
  const before = await nameOf(device.deviceId);
  const cashier = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Kasir',
    storeIds: [storeId],
    roleKeys: ['cashier'],
  });

  const res = await rename(device.token, { deviceName: 'Punya saya' }, cashier);
  expect(res.status).toBe(403);
  expect(await nameOf(device.deviceId)).toBe(before);
});

test('no acting user, a blank or too long name, and a control session are all refused', async () => {
  const { p, device } = await setup();
  const before = await nameOf(device.deviceId);

  expect((await rename(device.token, { deviceName: 'X' })).status).toBe(403);
  expect((await rename(device.token, { deviceName: '   ' }, p.ownerUserId)).status).toBe(422);
  expect((await rename(device.token, { deviceName: 'x'.repeat(65) }, p.ownerUserId)).status).toBe(
    422,
  );
  expect((await rename(device.token, { deviceName: 'X', extra: true }, p.ownerUserId)).status).toBe(
    422,
  );

  // A control session has no device to rename.
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  expect((await rename(control, { deviceName: 'X' })).status).toBe(401);

  expect(await nameOf(device.deviceId)).toBe(before);
});
