// Replacement enrolment (§4.3 `replacesDeviceId`; D27, task 168) — the SECURITY half.
//
// Re-enrolling an already-enrolled handset mints a new identity (§7.4) and must END the old one in
// the SAME transaction. These are the adversarial controls §2.5 requires before review: the happy
// path is one test, and every other test here is an attempt to get the server to revoke something it
// should not, or to leave the registry in a state the flow promises cannot exist.
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  makeIdentityHarness,
  provision,
  seedControlSession,
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
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  return { p, control, storeId: p.storeIds[0] as string };
}

function enrollBody(storeId: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceId: uuidv7(h.clock.now()),
    devicePublicKeyB64: Buffer.from(ed25519.keygen().publicKey).toString('base64'),
    storeId,
    deviceName: 'Tablet',
    platform: 'android',
    appVersion: '1.0.0',
    ...overrides,
  };
}

async function deviceRow(deviceId: string) {
  return h.idb.db
    .selectFrom('devices')
    .select(['id', 'status', 'revokedAt', 'revokedBy'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
}

test('replacement enrolment revokes the named device and registers the new one', async () => {
  const { control, storeId } = await setup();
  const first = enrollBody(storeId);
  const firstRes = await enroll(h, control, first, uuidv7(h.clock.now()));
  expect(firstRes.status).toBe(201);

  const second = enrollBody(storeId, { replacesDeviceId: first.deviceId });
  const secondRes = await enroll(h, control, second, uuidv7(h.clock.now()));
  expect(secondRes.status).toBe(201);

  // The promise of this flow: exactly one active registration for the handset, and the old identity
  // ended rather than orphaned.
  expect((await deviceRow(first.deviceId))?.status).toBe('revoked');
  expect((await deviceRow(second.deviceId))?.status).toBe('active');
});

test('the replaced device keeps its row and its key — the identity ends, it is not deleted', async () => {
  // §7.4 / 03 §5: revoked devices stay listed because their public keys keep verifying history. A
  // replacement that DELETED the row would silently break verification of everything it ever signed.
  const { control, storeId } = await setup();
  const first = enrollBody(storeId);
  await enroll(h, control, first, uuidv7(h.clock.now()));
  await enroll(
    h,
    control,
    enrollBody(storeId, { replacesDeviceId: first.deviceId }),
    uuidv7(h.clock.now()),
  );

  const row = await h.idb.db
    .selectFrom('devices')
    .select(['id', 'signingKeyPublic', 'status'])
    .where('id', '=', first.deviceId)
    .executeTakeFirst();
  expect(row).toBeDefined();
  expect(row?.signingKeyPublic).toBe(first.devicePublicKeyB64);
});

test('a replacesDeviceId that does not exist fails closed and registers NOTHING', async () => {
  // The whole operation is one transaction: a bad replacement target must not leave the new device
  // half-registered. This is the property that makes "never two active, never zero" true.
  const { control, storeId } = await setup();
  const body = enrollBody(storeId, { replacesDeviceId: uuidv7(h.clock.now()) });
  const res = await enroll(h, control, body, uuidv7(h.clock.now()));

  expect(res.status).toBe(404);
  expect(await deviceRow(body.deviceId)).toBeUndefined();
});

test("a replacesDeviceId naming ANOTHER tenant's device is indistinguishable from a missing one", async () => {
  // security-guide §2.2: cross-tenant existence must not be observable. The lookup is RLS-scoped, so
  // the other tenant's device reads as absent — the caller learns nothing about it, and gets the SAME
  // 404 a nonexistent id gets rather than a 403 that would confirm it exists.
  const a = await setup();
  const b = await setup();

  const victim = enrollBody(b.storeId);
  expect((await enroll(h, b.control, victim, uuidv7(h.clock.now()))).status).toBe(201);

  const attacker = enrollBody(a.storeId, { replacesDeviceId: victim.deviceId });
  const res = await enroll(h, a.control, attacker, uuidv7(h.clock.now()));

  expect(res.status).toBe(404);
  // The victim's device is untouched — the cross-tenant revoke did not happen.
  expect((await deviceRow(victim.deviceId))?.status).toBe('active');
  expect(await deviceRow(attacker.deviceId)).toBeUndefined();
});

test('omitting replacesDeviceId leaves every existing registration active', async () => {
  // The denominator control for the tests above: a plain enrolment must NOT revoke anything. Without
  // this, a bug that revoked unconditionally would still satisfy the happy-path test.
  const { control, storeId } = await setup();
  const first = enrollBody(storeId);
  await enroll(h, control, first, uuidv7(h.clock.now()));
  await enroll(h, control, enrollBody(storeId), uuidv7(h.clock.now()));

  expect((await deviceRow(first.deviceId))?.status).toBe('active');
});

test('replacing an already-revoked device does not re-stamp its revocation', async () => {
  // `revokeDevice` reports `newlyRevoked: false` for an already-revoked row. The replacement path
  // must not overwrite the original `revokedAt`/`revokedBy`, which are the audit record of WHEN and
  // BY WHOM the identity actually ended.
  const { control, storeId } = await setup();
  const first = enrollBody(storeId);
  await enroll(h, control, first, uuidv7(h.clock.now()));
  await enroll(
    h,
    control,
    enrollBody(storeId, { replacesDeviceId: first.deviceId }),
    uuidv7(h.clock.now()),
  );
  const afterFirst = await deviceRow(first.deviceId);

  h.clock.advance(60_000);
  const third = await enroll(
    h,
    control,
    enrollBody(storeId, { replacesDeviceId: first.deviceId }),
    uuidv7(h.clock.now()),
  );
  expect(third.status).toBe(201);

  const afterSecond = await deviceRow(first.deviceId);
  expect(afterSecond?.revokedAt).toEqual(afterFirst?.revokedAt);
});
