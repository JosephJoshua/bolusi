// Tenant settings (§6.4): auth.tenant_configure required; idleLock clamped 60–3600; audited; the
// change flips the bundle etag.
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
  return {
    p,
    storeId: p.storeIds[0] as string,
    control: await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId }),
  };
}

async function patchSettings(token: string, idleLockSeconds: number): Promise<Response> {
  return h.app.request('http://srv.test/v1/tenant/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idleLockSeconds }),
  });
}

test('PATCH /tenant/settings clamps idleLockSeconds to [60,3600], audits, and flips the bundle etag', async () => {
  const { p, storeId, control } = await setup();
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });
  const etagBefore = await bundleEtag(device.token);

  // Below the floor → clamped to 60.
  const low = await patchSettings(control, 10);
  expect(low.status).toBe(200);
  expect(
    ((await low.json()) as { settings: { idleLockSeconds: number } }).settings.idleLockSeconds,
  ).toBe(60);

  // Above the ceiling → clamped to 3600.
  const high = await patchSettings(control, 99999);
  expect(
    ((await high.json()) as { settings: { idleLockSeconds: number } }).settings.idleLockSeconds,
  ).toBe(3600);

  // Audited.
  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .select('id')
    .where('action', '=', 'tenant_settings.changed')
    .executeTakeFirst();
  expect(audit).toBeDefined();

  // Etag flips.
  const etagAfter = await bundleEtag(device.token);
  expect(etagAfter).not.toBe(etagBefore);
});

test('PATCH /tenant/settings without auth.tenant_configure → 403', async () => {
  const { p, storeId } = await setup();
  const storeOwner = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'SO',
    storeIds: [storeId],
    roleKeys: ['store_owner'],
  });
  const soControl = await seedControlSession(h, { tenantId: p.tenantId, userId: storeOwner });
  const res = await patchSettings(soControl, 300);
  expect(res.status).toBe(403);
});

async function bundleEtag(token: string): Promise<string> {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { etag: string }).etag;
}
