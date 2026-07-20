// X-Acting-User trust model (§4.5) + permission-id registry hygiene. GET /v1/devices is the probe:
// it resolves the acting user, then requires auth.device_read.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { PERM, PERMISSION_BY_ID, PERMISSIONS } from '../../src/identity/permissions.js';
import { uuidv7 } from '../../src/uuidv7.js';
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

async function getDevices(token: string, actingUser?: string): Promise<number> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (actingUser !== undefined) headers['X-Acting-User'] = actingUser;
  const res = await h.app.request('http://srv.test/v1/devices', { headers });
  return res.status;
}

test('X-Acting-User: missing / unknown / other-tenant / not-usable-on-device → 403 ACTING_USER_INVALID', async () => {
  const { p, device } = await setup();

  // Missing header.
  expect(await getDevices(device.token)).toBe(403);
  // Unknown id.
  expect(await getDevices(device.token, uuidv7(h.clock.now()))).toBe(403);

  // Other-tenant user id (RLS hides it → reads as absent → invalid).
  const other = await provision(h, {
    tenantName: 'Other',
    storeNames: ['S2'],
    ownerName: 'O2',
    ownerLogin: `o2-${Math.random()}`,
  });
  expect(await getDevices(device.token, other.ownerUserId)).toBe(403);

  // A user in this tenant but NOT in the device's store (not usable on this device).
  const s2 = uuidv7(h.clock.now());
  await h.idb.db
    .insertInto('stores')
    .values({ id: s2, tenantId: p.tenantId, name: 'S2', createdAt: 1n })
    .execute();
  const elsewhere = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Elsewhere',
    storeIds: [s2],
    roleKeys: ['store_owner'],
  });
  expect(await getDevices(device.token, elsewhere)).toBe(403);
});

test('X-Acting-User: usable on the device but lacking auth.device_read → 403 PERMISSION_DENIED (distinct from ACTING_USER_INVALID)', async () => {
  const { p, storeId, device } = await setup();
  // A staff user in the device's store: usable, but staff holds no auth.device_read.
  const staff = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Staff',
    storeIds: [storeId],
    roleKeys: ['staff'],
  });
  const res = await h.app.request('http://srv.test/v1/devices', {
    headers: { Authorization: `Bearer ${device.token}`, 'X-Acting-User': staff },
  });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');

  // The owner (device_read via main_owner) → 200.
  expect(await getDevices(device.token, p.ownerUserId)).toBe(200);
  // A control session for the owner → 200 (control-session path, no X-Acting-User).
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  expect(await getDevices(control)).toBe(200);
});

test('permission ids used in the §4.5 checks are exactly 02-permissions §11 registry strings (no module-prefix variants)', async () => {
  // Every PERM constant resolves in the registry — a typo like `devices.enroll` would not.
  for (const id of Object.values(PERM)) {
    expect(PERMISSION_BY_ID.has(id), `${id} not in the registry`).toBe(true);
  }
  // Non-vacuity (T-14): the registry is the full v0 set, not silently empty.
  expect(PERMISSIONS).toHaveLength(19);
  expect(PERMISSION_BY_ID.size).toBe(19);
});

test('drift guard: the canonical @bolusi/core permission registry matches the seeded DB permissions table exactly', async () => {
  // THE BOUNDARY (task 33). `PERMISSIONS` is now the ONE registry assembled from the `@bolusi/core`
  // module manifests (identity/permissions.ts); migration 0008 seeds the `permissions` table from a
  // hand-authored SQL list. These are two INDEPENDENT encodings of 02-permissions §11 — the core
  // vocabulary that the bundle snapshot + §4.5 checks read, and the FK-backing rows the grants point
  // at. A permission present in one and not the other (or with a different scope / isDangerous /
  // description) is a silent authz-or-audit divergence no single-package test can see. This guard
  // fires the moment they disagree — id, scope, isDangerous, AND the canonical EN description (the
  // bundle ships it as the client's label fallback, 07-i18n §3.1).
  const rows = await h.idb.db
    .selectFrom('permissions')
    .select(['id', 'scope', 'isDangerous', 'description'])
    .execute();
  expect(rows.length, 'permissions table is empty — the drift guard would be vacuous').toBe(19);
  const dbById = new Map(
    rows.map((r) => [
      r.id,
      { scope: r.scope, isDangerous: r.isDangerous, description: r.description },
    ]),
  );
  // Both directions: every core-registry entry is in the seed (loop below) AND the seed has no id the
  // core registry lacks (equal counts, both asserted 19 — T-14 denominator).
  expect(PERMISSIONS).toHaveLength(rows.length);
  for (const p of PERMISSIONS) {
    const db = dbById.get(p.id);
    expect(db, `${p.id} missing from the DB seed`).toBeDefined();
    expect(db?.scope, `${p.id} scope`).toBe(p.scope);
    expect(db?.isDangerous, `${p.id} isDangerous`).toBe(p.isDangerous);
    expect(db?.description, `${p.id} description`).toBe(p.description);
  }
});
