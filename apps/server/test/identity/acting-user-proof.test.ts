// A device token proves the device, never the person (auth/acting-user.ts). Found by the cheating
// audit (2026-11-25): with only a copied store-device token, a Kasir set the store owner's PIN through
// the "own change" door and could then sign in anywhere as the owner. These pin down that the server
// takes a person on a control-plane call only on proof it checked itself.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { FIRST_PIN_WINDOW_MS } from '../../src/routes/users.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  makeIdentityHarness,
  provision,
  seedDevice,
  seedPersonSession,
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

async function store() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['A'],
    ownerName: 'Main',
    ownerLogin: `proof-${Math.random()}`,
  });
  const storeId = p.storeIds[0] as string;
  const storeOwner = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Store Owner',
    storeIds: [storeId],
    roleKeys: ['store_owner'],
  });
  const kasir = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Kasir',
    storeIds: [storeId],
    roleKeys: ['cashier'],
  });
  const counter = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: storeOwner });
  return { p, storeId, storeOwner, kasir, counter };
}

let seq = 0;
function verifierBody(deviceId: string) {
  seq += 1;
  return JSON.stringify({
    verifierRef: uuidv7(h.clock.now() + seq),
    verifier: {
      algorithm: 'argon2id',
      saltB64: Buffer.alloc(16, seq).toString('base64'),
      mKiB: 32768,
      t: 3,
      p: 1,
      hashB64: Buffer.alloc(32, seq).toString('base64'),
      asOf: { timestamp: h.clock.now(), deviceId, seq },
    },
  });
}

function setPin(
  target: string,
  device: { readonly token: string; readonly deviceId: string },
  headers: Record<string, string>,
) {
  return h.app.request(`http://srv.test/v1/users/${target}/pin-verifier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${device.token}`,
      ...headers,
    },
    body: verifierBody(device.deviceId),
  });
}

async function pinOf(userId: string) {
  return h.idb.db
    .selectFrom('userPinVerifiers')
    .select('hash')
    .where('userId', '=', userId)
    .executeTakeFirst();
}

async function hasPin(userId: string): Promise<boolean> {
  const row = await h.idb.db
    .selectFrom('userPinVerifiers')
    .select('userId')
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

test("a Kasir's own phone acts only as the Kasir: it cannot set the store owner's PIN", async () => {
  const { p, storeId, storeOwner, kasir } = await store();
  const phone = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: storeOwner });
  await h.idb.db
    .updateTable('devices')
    .set({ personalUserId: kasir })
    .where('id', '=', phone.deviceId)
    .execute();

  const forged = await setPin(storeOwner, phone, { 'X-Acting-User': storeOwner });
  expect(forged.status).toBe(403);
  expect(((await forged.json()) as { error: { code: string } }).error.code).toBe(
    'ACTING_USER_INVALID',
  );
  expect(await hasPin(storeOwner)).toBe(false);

  // Positive control: the phone's own person changes their own PIN.
  expect((await setPin(kasir, phone, { 'X-Acting-User': kasir })).status).toBe(200);
});

test('a shared counter device acts as a person only with their own live person session', async () => {
  const { p, storeOwner, kasir, counter } = await store();
  const tenantId = p.tenantId;
  // The owner already has a PIN, so only a proven owner may change it.
  const live = await seedPersonSession(h, {
    tenantId,
    deviceId: counter.deviceId,
    userId: storeOwner,
  });
  const first = await setPin(storeOwner, counter, {
    'X-Acting-User': storeOwner,
    'X-Person-Session': live,
  });
  expect(first.status).toBe(200);
  const pinBefore = await pinOf(storeOwner);

  // The name alone, as a copied token sends it.
  expect((await setPin(storeOwner, counter, { 'X-Acting-User': storeOwner })).status).toBe(403);
  // The Kasir's own session, naming the owner.
  const kasirSession = await seedPersonSession(h, {
    tenantId,
    deviceId: counter.deviceId,
    userId: kasir,
  });
  expect(
    (
      await setPin(storeOwner, counter, {
        'X-Acting-User': storeOwner,
        'X-Person-Session': kasirSession,
      })
    ).status,
  ).toBe(403);
  // The owner's session, but from another device.
  const other = await seedDevice(h, { tenantId, storeId: p.storeIds[0] as string });
  const elsewhere = await seedPersonSession(h, {
    tenantId,
    deviceId: other.deviceId,
    userId: storeOwner,
  });
  expect(
    (
      await setPin(storeOwner, counter, {
        'X-Acting-User': storeOwner,
        'X-Person-Session': elsewhere,
      })
    ).status,
  ).toBe(403);
  // The owner's session here, ended.
  const expired = await seedPersonSession(h, {
    tenantId,
    deviceId: counter.deviceId,
    userId: storeOwner,
    expiresAt: h.clock.now() - 1,
  });
  expect(
    (
      await setPin(storeOwner, counter, {
        'X-Acting-User': storeOwner,
        'X-Person-Session': expired,
      })
    ).status,
  ).toBe(403);
  expect(await pinOf(storeOwner)).toEqual(pinBefore);

  // Positive control: the owner, whose PIN the server just checked on this device.
  expect(
    (await setPin(storeOwner, counter, { 'X-Acting-User': storeOwner, 'X-Person-Session': live }))
      .status,
  ).toBe(200);
});

test('a copied counter token cannot add staff or change limits as the owner', async () => {
  const { p, storeId, storeOwner, counter } = await store();
  const cashierRole = await h.idb.db
    .selectFrom('roles')
    .select('id')
    .where('tenantId', '=', p.tenantId)
    .where('name', '=', 'cashier')
    .executeTakeFirstOrThrow();
  const created = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${counter.token}`,
      'X-Acting-User': storeOwner,
    },
    body: JSON.stringify({
      name: 'Ghost',
      loginIdentifier: null,
      password: null,
      storeIds: [storeId],
      roleIds: [cashierRole.id],
      pinVerifier: null,
    }),
  });
  expect(created.status).toBe(403);
  const ghost = await h.idb.db
    .selectFrom('users')
    .select('id')
    .where('name', '=', 'Ghost')
    .executeTakeFirst();
  expect(ghost).toBeUndefined();
});

test('the enrolling owner makes their own first PIN without a session, and nobody else does', async () => {
  const { p, storeOwner, kasir, counter } = await store();
  // A Kasir has no PIN yet: the counter cannot make one for them in their name.
  expect((await setPin(kasir, counter, { 'X-Acting-User': kasir })).status).toBe(403);
  expect(await hasPin(kasir)).toBe(false);
  // The main owner did not enrol this counter.
  expect((await setPin(p.ownerUserId, counter, { 'X-Acting-User': p.ownerUserId })).status).toBe(
    403,
  );
  // The owner who enrolled it makes their first PIN, right after enrolment.
  expect((await setPin(storeOwner, counter, { 'X-Acting-User': storeOwner })).status).toBe(200);
  // Once a PIN exists, changing it needs them proven.
  expect((await setPin(storeOwner, counter, { 'X-Acting-User': storeOwner })).status).toBe(403);
});

test('the first-PIN door closes a day after enrolment', async () => {
  const { storeOwner, counter } = await store();
  h.clock.advance(FIRST_PIN_WINDOW_MS + 1);
  expect((await setPin(storeOwner, counter, { 'X-Acting-User': storeOwner })).status).toBe(403);
  expect(await hasPin(storeOwner)).toBe(false);
});
