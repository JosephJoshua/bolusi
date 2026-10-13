import { afterEach, beforeEach, expect, test } from 'vitest';

import { uuidv7 } from '../../src/uuidv7.js';
import {
  makeIdentityHarness,
  provision,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let harness: IdentityHarness;
beforeEach(async () => {
  harness = await makeIdentityHarness();
});
afterEach(async () => {
  await harness.close();
});

async function directory(seed: number) {
  const tenant = await provision(harness, {
    tenantName: `Tenant ${seed}`,
    storeNames: [`Store A ${seed}`, `Store B ${seed}`],
    ownerName: `Main Owner ${seed}`,
    ownerLogin: `pin-boundary-owner-${seed}`,
  });
  const storeA = tenant.storeIds[0] as string;
  const storeB = tenant.storeIds[1] as string;
  const storeOwner = await seedUser(harness, {
    tenantId: tenant.tenantId,
    name: `Store Owner ${seed}`,
    storeIds: [storeA],
    roleKeys: ['store_owner'],
  });
  const device = await seedDevice(harness, { tenantId: tenant.tenantId, storeId: storeA });
  return { tenant, storeA, storeB, storeOwner, device };
}

function verifierBody(seed: number) {
  return {
    verifierRef: uuidv7(harness.clock.now() + seed),
    verifier: {
      algorithm: 'argon2id',
      saltB64: Buffer.alloc(16, seed).toString('base64'),
      mKiB: 32768,
      t: 3,
      p: 1,
      hashB64: Buffer.alloc(32, seed).toString('base64'),
      asOf: { timestamp: seed * 1000, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 },
    },
  };
}

function putVerifier(userId: string, actorUserId: string, token: string, seed: number) {
  return harness.app.request(`http://srv.test/v1/users/${userId}/pin-verifier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Acting-User': actorUserId,
    },
    body: JSON.stringify(verifierBody(seed)),
  });
}

async function storedVerifier(userId: string) {
  return harness.idb.db
    .selectFrom('userPinVerifiers')
    .select(['hash', 'asOfTimestamp', 'asOfDeviceId', 'asOfSeq'])
    .where('userId', '=', userId)
    .executeTakeFirst();
}

test.each([
  { seed: 21, memberships: 'B only' as const },
  { seed: 22, memberships: 'A and B' as const },
])(
  'store-A owner cannot reset a $memberships user (restriction and denial audit)',
  async ({ seed, memberships }) => {
    const { tenant, storeA, storeB, storeOwner, device } = await directory(seed);
    const targetUserId = await seedUser(harness, {
      tenantId: tenant.tenantId,
      name: `Target ${seed}`,
      storeIds: memberships === 'B only' ? [storeB] : [storeA, storeB],
      roleKeys: ['staff'],
    });
    const initial = await putVerifier(targetUserId, tenant.ownerUserId, device.token, seed);
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { applied: boolean }).toMatchObject({ applied: true });
    const before = await storedVerifier(targetUserId);
    expect(before).toBeDefined();

    const response = await putVerifier(targetUserId, storeOwner, device.token, seed + 10);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'PERMISSION_DENIED',
    );
    expect(await storedVerifier(targetUserId)).toEqual(before);

    const denials = await harness.idb.db
      .selectFrom('identityAudit')
      .select(['actorUserId', 'action', 'entityType', 'entityId', 'after'])
      .where('tenantId', '=', tenant.tenantId)
      .where('action', '=', 'permission.denied')
      .execute();
    expect(denials).toEqual([
      {
        actorUserId: storeOwner,
        action: 'permission.denied',
        entityType: 'permission_denial',
        entityId: null,
        after: {
          permissionId: 'auth.user_reset_pin',
          scopeStoreId: storeB,
          target: `POST /v1/users/${targetUserId}/pin-verifier`,
          reason: 'restriction_violated',
          deviceId: device.deviceId,
        },
      },
    ]);
    const writes = await harness.idb.db
      .selectFrom('identityAudit')
      .select('actorUserId')
      .where('tenantId', '=', tenant.tenantId)
      .where('action', '=', 'pin_verifier.replaced')
      .where('entityId', '=', targetUserId)
      .execute();
    expect(writes).toEqual([{ actorUserId: tenant.ownerUserId }]);
  },
);

test('store-A owner can reset a store-A-only user', async () => {
  const seed = 23;
  const { tenant, storeA, storeOwner, device } = await directory(seed);
  const targetUserId = await seedUser(harness, {
    tenantId: tenant.tenantId,
    name: `Target ${seed}`,
    storeIds: [storeA],
    roleKeys: ['staff'],
  });

  const response = await putVerifier(targetUserId, storeOwner, device.token, seed);
  expect(response.status).toBe(200);
  expect((await response.json()) as { applied: boolean }).toMatchObject({ applied: true });
  expect((await storedVerifier(targetUserId))?.hash).toBe(verifierBody(seed).verifier.hashB64);
});

test('tenant-wide main owner can reset a store-B-only user from a store-A device', async () => {
  const seed = 24;
  const { tenant, storeB, device } = await directory(seed);
  const targetUserId = await seedUser(harness, {
    tenantId: tenant.tenantId,
    name: `Target ${seed}`,
    storeIds: [storeB],
    roleKeys: ['staff'],
  });

  const response = await putVerifier(targetUserId, tenant.ownerUserId, device.token, seed);
  expect(response.status).toBe(200);
  expect((await response.json()) as { applied: boolean }).toMatchObject({ applied: true });
  expect((await storedVerifier(targetUserId))?.hash).toBe(verifierBody(seed).verifier.hashB64);
});

test('own PIN change needs no reset permission, even for a user in both stores', async () => {
  const seed = 25;
  const { tenant, storeA, storeB, device } = await directory(seed);
  const targetUserId = await seedUser(harness, {
    tenantId: tenant.tenantId,
    name: `Target ${seed}`,
    storeIds: [storeA, storeB],
    roleKeys: ['staff'],
  });

  const response = await putVerifier(targetUserId, targetUserId, device.token, seed);
  expect(response.status).toBe(200);
  expect((await response.json()) as { applied: boolean }).toMatchObject({ applied: true });
  expect((await storedVerifier(targetUserId))?.hash).toBe(verifierBody(seed).verifier.hashB64);
});
