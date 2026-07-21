// Task 114 (class sweep) — `POST /v1/devices/enroll` must NOT be a cross-tenant existence oracle.
//
// `devices.id` is a GLOBAL uuid PK (10-db §7). Enroll's `dupId` SELECT is RLS-scoped, so a device
// id an RLS-hidden row in ANOTHER tenant already holds reads as absent and the handler proceeds to
// INSERT — which trips the global PK (RLS filters SELECTs, not unique-index conflicts, 10-db §6).
// Before the fix that unique violation escaped `withIdentityErrors` as `500 INTERNAL`, while a
// SAME-tenant duplicate id answered a clean `409 ENROLL_DEVICE_ID_TAKEN`: the status singled out
// cross-tenant existence. The fix maps the collision to the SAME 409, so cross-tenant and
// same-tenant existence are indistinguishable and nothing leaks (security-guide §2.2; task 114).
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { readError } from '../helpers/http.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  makeIdentityHarness,
  provision,
  seedControlSession,
  seedDevice,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

function enrollBody(storeId: string, deviceId: string): Record<string, unknown> {
  return {
    deviceId,
    devicePublicKeyB64: Buffer.from(ed25519.keygen().publicKey).toString('base64'),
    storeId,
    deviceName: 'Tablet',
    platform: 'android',
    appVersion: '1.0.0',
  };
}

test('task 114 — cross-tenant device-id enroll is the SAME 409 ENROLL_DEVICE_ID_TAKEN as a same-tenant duplicate, never a 500 oracle', async () => {
  // Tenant A: owner (holds auth.device_enroll via main_owner) + store + control session.
  const A = await provision(h, {
    tenantName: 'A',
    storeNames: ['SA'],
    ownerName: 'OA',
    ownerLogin: `oa-${Math.random()}`,
  });
  const storeA = A.storeIds[0] as string;
  const controlA = await seedControlSession(h, { tenantId: A.tenantId, userId: A.ownerUserId });

  // Tenant B: a real device whose global id tenant A will probe.
  const B = await provision(h, {
    tenantName: 'B',
    storeNames: ['SB'],
    ownerName: 'OB',
    ownerLogin: `ob-${Math.random()}`,
  });
  const storeB = B.storeIds[0] as string;
  const bDevice = await seedDevice(h, {
    tenantId: B.tenantId,
    storeId: storeB,
    enrolledBy: B.ownerUserId,
  });

  // Non-vacuity (T-14b): B's device exists (owner handle) but is RLS-hidden from A.
  const present = await h.idb.db
    .selectFrom('devices')
    .select('id')
    .where('id', '=', bDevice.deviceId)
    .executeTakeFirst();
  expect(present).toBeDefined();
  const aSees = await h.idb.forTenant(A.tenantId, (db) =>
    db.selectFrom('devices').select('id').where('id', '=', bDevice.deviceId).execute(),
  );
  expect(aSees).toEqual([]); // RLS hides B's device from A

  // Cross-tenant probe: A enrolls a device whose id == B's device id, into A's own store.
  const cross = await enroll(
    h,
    controlA,
    enrollBody(storeA, bDevice.deviceId),
    uuidv7(h.clock.now()),
  );
  expect(cross.status, 'cross-tenant enroll must not be a 500 existence oracle').toBe(409);
  expect((await readError(cross)).error.code).toBe('ENROLL_DEVICE_ID_TAKEN');

  // Comparator: a SAME-tenant duplicate id yields the identical 409 ENROLL_DEVICE_ID_TAKEN.
  const aDevice = await seedDevice(h, {
    tenantId: A.tenantId,
    storeId: storeA,
    enrolledBy: A.ownerUserId,
  });
  const same = await enroll(
    h,
    controlA,
    enrollBody(storeA, aDevice.deviceId),
    uuidv7(h.clock.now()),
  );
  expect(same.status).toBe(409);
  expect((await readError(same)).error.code).toBe('ENROLL_DEVICE_ID_TAKEN');

  // Fail-closed: the cross-tenant probe created NO tenant-A row for B's id; B's device untouched.
  const aRows = await h.idb.forTenant(A.tenantId, (db) =>
    db.selectFrom('devices').select('id').where('id', '=', bDevice.deviceId).execute(),
  );
  expect(aRows).toEqual([]);
  const bRow = await h.idb.db
    .selectFrom('devices')
    .select(['id', 'tenantId'])
    .where('id', '=', bDevice.deviceId)
    .executeTakeFirstOrThrow();
  expect(bRow.tenantId).toBe(B.tenantId);

  // Positive control: a genuinely-new id still enrolls (201).
  const fresh = await enroll(
    h,
    controlA,
    enrollBody(storeA, uuidv7(h.clock.now())),
    uuidv7(h.clock.now()),
  );
  expect(fresh.status).toBe(201);
});
