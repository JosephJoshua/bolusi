// A store's limits for a limited role (product-scope.md, "Managers, limits, approvals and roles"):
// set by whoever holds auth.limit_manage at that store, never by someone holding the role, only for
// a limited role, audited, and carried in that store's bundle only.
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

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

const AMOUNTS = { priceDrop: 50_000, refund: 25_000, credit: 100_000 };

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['A', 'B'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const [storeA, storeB] = p.storeIds as [string, string];
  return {
    p,
    storeA,
    storeB,
    manager: await roleIdOf(h, p.tenantId, 'manager'),
    owner: await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId }),
  };
}

async function put(token: string, body: Record<string, unknown>): Promise<Response> {
  return h.app.request('http://srv.test/v1/role-limits', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function bundleRoles(token: string) {
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    bundle: { rolesSnapshot: { id: string; name: string; limits?: unknown }[] };
  };
  return body.bundle.rolesSnapshot;
}

test('the owner sets a store’s manager limits; that store’s bundle carries them, another’s Rp 0', async () => {
  const { p, storeA, storeB, manager, owner } = await setup();
  const deviceA = await seedDevice(h, { tenantId: p.tenantId, storeId: storeA });
  const deviceB = await seedDevice(h, { tenantId: p.tenantId, storeId: storeB });

  const before = await bundleRoles(deviceA.token);
  expect(before.find((r) => r.id === manager)?.limits).toStrictEqual({
    priceDrop: 0,
    refund: 0,
    credit: 0,
  });
  // A role free of limits says so.
  expect(before.find((r) => r.name === 'store_owner')?.limits).toBeNull();

  const res = await put(owner, { storeId: storeA, roleId: manager, ...AMOUNTS });
  expect(res.status).toBe(200);
  expect((await bundleRoles(deviceA.token)).find((r) => r.id === manager)?.limits).toStrictEqual(
    AMOUNTS,
  );
  expect((await bundleRoles(deviceB.token)).find((r) => r.id === manager)?.limits).toStrictEqual({
    priceDrop: 0,
    refund: 0,
    credit: 0,
  });

  // A second change replaces the first, and both are audited.
  await put(owner, { storeId: storeA, roleId: manager, ...AMOUNTS, refund: 0 });
  expect((await bundleRoles(deviceA.token)).find((r) => r.id === manager)?.limits).toMatchObject({
    refund: 0,
    priceDrop: 50_000,
  });
  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .select(['actorUserId', 'entityId'])
    .where('action', '=', 'role_limits.changed')
    .execute();
  expect(audit).toHaveLength(2);
  expect(audit[0]).toStrictEqual({ actorUserId: p.ownerUserId, entityId: manager });
});

test('a store owner sets their own store’s limits, not another store’s', async () => {
  const { p, storeA, storeB, manager } = await setup();
  const storeOwner = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'SO',
    storeIds: [storeA],
    roleKeys: ['store_owner'],
  });
  const token = await seedControlSession(h, { tenantId: p.tenantId, userId: storeOwner });
  expect((await put(token, { storeId: storeA, roleId: manager, ...AMOUNTS })).status).toBe(200);
  expect((await put(token, { storeId: storeB, roleId: manager, ...AMOUNTS })).status).toBe(403);
});

test('refused: no auth.limit_manage, a role free of limits, and anyone holding the role', async () => {
  const { p, storeA, manager, owner } = await setup();
  const cashier = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'K',
    storeIds: [storeA],
    roleKeys: ['cashier'],
  });
  const cashierToken = await seedControlSession(h, { tenantId: p.tenantId, userId: cashier });
  expect((await put(cashierToken, { storeId: storeA, roleId: manager, ...AMOUNTS })).status).toBe(
    403,
  );

  // Only a limited role has limits.
  const cashierRole = await roleIdOf(h, p.tenantId, 'cashier');
  expect((await put(owner, { storeId: storeA, roleId: cashierRole, ...AMOUNTS })).status).toBe(403);

  // A manager who is also a store owner still does not set the manager's limits.
  const both = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'M',
    storeIds: [storeA],
    roleKeys: ['manager', 'store_owner'],
  });
  const bothToken = await seedControlSession(h, { tenantId: p.tenantId, userId: both });
  expect((await put(bothToken, { storeId: storeA, roleId: manager, ...AMOUNTS })).status).toBe(403);
  const rows = await h.idb.db.selectFrom('roleLimits').select('roleId').execute();
  expect(rows).toHaveLength(0);
});

test('amounts are whole, never negative, and bounded', async () => {
  const { storeA, manager, owner } = await setup();
  for (const bad of [-1, 1.5, 1_000_000_000_001]) {
    const res = await put(owner, { storeId: storeA, roleId: manager, ...AMOUNTS, refund: bad });
    expect(res.status).toBe(422);
  }
});

test('the Manajer settles no drawer shortage: owners keep money.adjust_cash', async () => {
  const { manager } = await setup();
  const held = await h.idb.db
    .selectFrom('rolePermissions')
    .select('permissionId')
    .where('roleId', '=', manager)
    .execute();
  expect(held.map((r) => r.permissionId)).not.toContain('money.adjust_cash');
});
