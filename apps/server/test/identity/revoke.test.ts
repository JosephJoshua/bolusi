// Device revocation server effects (§7): both auth paths, idempotency, self-revoke, push-token
// cleanup, the audit row, and the on-revoke hook registry (task 20 registers socket-close there).
import { afterEach, beforeEach, expect, test } from 'vitest';

import { uuidv7 } from '../../src/uuidv7.js';
import {
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

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  return { p, storeId: p.storeIds[0] as string };
}

async function seedPushToken(deviceId: string, tenantId: string): Promise<void> {
  await h.idb.db
    .insertInto('pushTokens')
    .values({
      id: uuidv7(h.clock.now()),
      tenantId,
      deviceId,
      expoPushToken: `ExponentPushToken[${deviceId}]`,
      updatedAt: BigInt(h.clock.now()),
    })
    .execute();
}

test('revoke via control session: 200 with the flip; push-token rows deleted; audit + hooks fire; repeat revoke is idempotent', async () => {
  const { p, storeId } = await setup();
  const target = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });
  await seedPushToken(target.deviceId, p.tenantId);
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });

  const fired: string[] = [];
  h.hooks.register((ctx) => {
    fired.push(ctx.deviceId);
  });

  const res = await h.app.request(`http://srv.test/v1/devices/${target.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; revokedAt: number };
  expect(body.status).toBe('revoked');
  expect(body.revokedAt).toBeGreaterThan(0);

  // Push-token rows deleted.
  const push = await h.idb.db
    .selectFrom('pushTokens')
    .select('id')
    .where('deviceId', '=', target.deviceId)
    .execute();
  expect(push).toHaveLength(0);

  // Audit row with revokedBy/revokedAt.
  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .selectAll()
    .where('action', '=', 'device.revoked')
    .where('entityId', '=', target.deviceId)
    .executeTakeFirst();
  expect(audit?.actorUserId).toBe(p.ownerUserId);
  expect((audit?.after as { revokedAt: number }).revokedAt).toBe(body.revokedAt);

  // Hook fired once, for this device.
  expect(fired).toEqual([target.deviceId]);

  // Repeat revoke → identical body, no extra hook fire (idempotent).
  const repeat = await h.app.request(`http://srv.test/v1/devices/${target.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toEqual(body);
  expect(fired).toEqual([target.deviceId]); // still just one fire
});

test('device path + self-revoke: an enrolled device revokes itself; its very next request → 401 DEVICE_REVOKED', async () => {
  const { p, storeId } = await setup();
  const self = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });

  const res = await h.app.request(`http://srv.test/v1/devices/${self.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${self.token}`, 'X-Acting-User': p.ownerUserId },
  });
  expect(res.status).toBe(200);

  // The very next request with that token → 401 DEVICE_REVOKED.
  const next = await h.app.request('http://srv.test/v1/devices/me', {
    headers: { Authorization: `Bearer ${self.token}` },
  });
  expect(next.status).toBe(401);
  expect(((await next.json()) as { error: { code: string } }).error.code).toBe('DEVICE_REVOKED');
});

test('revoke of an unknown device id in this tenant → 404', async () => {
  const { p } = await setup();
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  const res = await h.app.request(`http://srv.test/v1/devices/${uuidv7(h.clock.now())}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(res.status).toBe(404);
});
