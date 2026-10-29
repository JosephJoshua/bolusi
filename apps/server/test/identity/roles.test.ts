// The role editor (product-scope.md, "Managers, limits, approvals and roles"): only the main owner
// makes, edits and deletes roles; the owners' roles are never changed; a role holds only what the
// editor's switches offer; and every change is audited and reaches devices with their bundle.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { abilitiesOf, permissionsFor } from '@bolusi/modules';

import { DEFAULT_ROLES } from '../../src/identity/permissions.js';
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

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['A'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const storeA = p.storeIds[0]!;
  const storeOwner = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'SO',
    storeIds: [storeA],
    roleKeys: ['store_owner'],
  });
  return {
    p,
    storeA,
    owner: await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId }),
    storeOwner: await seedControlSession(h, { tenantId: p.tenantId, userId: storeOwner }),
    cashier: await roleIdOf(h, p.tenantId, 'cashier'),
    manager: await roleIdOf(h, p.tenantId, 'manager'),
  };
}

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return h.app.request(`http://srv.test/v1/roles${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function roleRow(roleId: string) {
  const role = await h.idb.db
    .selectFrom('roles')
    .select(['name', 'limited', 'isSystemDefault'])
    .where('id', '=', roleId)
    .executeTakeFirst();
  const permissions = await h.idb.db
    .selectFrom('rolePermissions')
    .select('permissionId')
    .where('roleId', '=', roleId)
    .execute();
  return role === undefined
    ? undefined
    : { ...role, permissionIds: permissions.map((row) => row.permissionId).sort() };
}

test('every preset but the owners’ opens in the editor exactly as it is', () => {
  for (const role of DEFAULT_ROLES.filter(
    (r) => r.scopeType === 'store' && r.key !== 'store_owner',
  )) {
    expect(permissionsFor(abilitiesOf(role.permissionIds))).toStrictEqual(
      [...role.permissionIds].sort(),
    );
  }
});

describe('making a role', () => {
  test('a copy of another: its switches, its limits flag, its own name; on record and in the bundle', async () => {
    const { p, storeA, owner, manager } = await setup();
    const res = await call(owner, 'POST', '', { name: 'Kasir senior', copyFromRoleId: manager });
    expect(res.status).toBe(201);
    const { roleId } = (await res.json()) as { roleId: string };
    const copy = await roleRow(roleId);
    expect(copy).toMatchObject({ name: 'Kasir senior', limited: true, isSystemDefault: false });
    expect(copy?.permissionIds).toStrictEqual((await roleRow(manager))?.permissionIds);

    const audit = await h.idb.db
      .selectFrom('identityAudit')
      .select(['actorUserId', 'entityId'])
      .where('action', '=', 'role.created')
      .execute();
    expect(audit).toStrictEqual([{ actorUserId: p.ownerUserId, entityId: roleId }]);

    const device = await seedDevice(h, { tenantId: p.tenantId, storeId: storeA });
    const bundle = (await (
      await h.app.request('http://srv.test/v1/devices/me/bundle', {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { bundle: { rolesSnapshot: { id: string; name: string }[] } };
    expect(bundle.bundle.rolesSnapshot.find((r) => r.id === roleId)?.name).toBe('Kasir senior');
  });

  test('refused: a taken or preset name, an owner role to copy, and anyone but the main owner', async () => {
    const { p, owner, storeOwner, cashier } = await setup();
    expect((await call(owner, 'POST', '', { name: 'X', copyFromRoleId: cashier })).status).toBe(
      201,
    );
    expect((await call(owner, 'POST', '', { name: ' x ', copyFromRoleId: cashier })).status).toBe(
      422,
    );
    expect(
      (await call(owner, 'POST', '', { name: 'Cashier', copyFromRoleId: cashier })).status,
    ).toBe(422);
    const storeOwnerRole = await roleIdOf(h, p.tenantId, 'store_owner');
    expect(
      (await call(owner, 'POST', '', { name: 'Y', copyFromRoleId: storeOwnerRole })).status,
    ).toBe(403);
    expect(
      (await call(storeOwner, 'POST', '', { name: 'Z', copyFromRoleId: cashier })).status,
    ).toBe(403);
    expect((await call(owner, 'POST', '', { name: '', copyFromRoleId: cashier })).status).toBe(422);
  });
});

describe('editing a role', () => {
  test('the main owner changes a preset’s switches and limits flag, and it is audited', async () => {
    const { owner, cashier } = await setup();
    const permissionIds = permissionsFor(new Set(['repairView', 'repairIntake']));
    const res = await call(owner, 'PATCH', `/${cashier}`, { permissionIds, limited: true });
    expect(res.status).toBe(200);
    expect(await roleRow(cashier)).toMatchObject({ limited: true, permissionIds });
    const audit = await h.idb.db
      .selectFrom('identityAudit')
      .select(['before', 'after'])
      .where('action', '=', 'role.updated')
      .executeTakeFirstOrThrow();
    expect(audit.after).toStrictEqual({ permissionIds, limited: true });
    expect((audit.before as { limited: boolean }).limited).toBe(false);
  });

  test('a made role is renamed; a preset keeps its name', async () => {
    const { owner, cashier } = await setup();
    const { roleId } = (await (
      await call(owner, 'POST', '', { name: 'Kasir senior', copyFromRoleId: cashier })
    ).json()) as { roleId: string };
    expect((await call(owner, 'PATCH', `/${roleId}`, { name: 'Kasir utama' })).status).toBe(200);
    expect((await roleRow(roleId))?.name).toBe('Kasir utama');
    expect((await call(owner, 'PATCH', `/${cashier}`, { name: 'Kasir' })).status).toBe(422);
  });

  test('refused: what no switch offers, half a switch, an owner role, anyone but the main owner', async () => {
    const { p, owner, storeOwner, cashier } = await setup();
    const before = await roleRow(cashier);
    for (const permissionIds of [
      ['auth.user_create'],
      ['auth.role_manage'],
      ['money.read', 'money.move_cash'],
      ['repair.work'],
    ]) {
      expect((await call(owner, 'PATCH', `/${cashier}`, { permissionIds })).status).toBe(422);
    }
    const storeOwnerRole = await roleIdOf(h, p.tenantId, 'store_owner');
    expect((await call(owner, 'PATCH', `/${storeOwnerRole}`, { permissionIds: [] })).status).toBe(
      403,
    );
    const mainOwnerRole = await roleIdOf(h, p.tenantId, 'main_owner');
    expect((await call(owner, 'PATCH', `/${mainOwnerRole}`, { limited: true })).status).toBe(403);
    expect((await call(storeOwner, 'PATCH', `/${cashier}`, { limited: true })).status).toBe(403);
    // Not an id at all is refused like any role that is not there, never a server error.
    expect((await call(owner, 'PATCH', '/not-a-role', { limited: true })).status).toBe(403);
    expect((await call(owner, 'DELETE', '/not-a-role')).status).toBe(403);
    // Clearing a PIN lockout stays the owners': guessing would start over on an offline phone.
    expect(
      (await call(owner, 'PATCH', `/${cashier}`, { permissionIds: ['auth.pin_unlock'] })).status,
    ).toBe(422);
    expect(await roleRow(cashier)).toStrictEqual(before);
  });
});

describe('deleting a role', () => {
  test('a made role nobody holds; never a preset, never one someone holds', async () => {
    const { p, storeA, owner, storeOwner, cashier } = await setup();
    const make = async (name: string) =>
      (
        (await (await call(owner, 'POST', '', { name, copyFromRoleId: cashier })).json()) as {
          roleId: string;
        }
      ).roleId;
    const unused = await make('Sementara');
    expect((await call(storeOwner, 'DELETE', `/${unused}`)).status).toBe(403);
    expect((await call(owner, 'DELETE', `/${unused}`)).status).toBe(200);
    expect(await roleRow(unused)).toBeUndefined();

    const held = await make('Dipakai');
    await seedUser(h, {
      tenantId: p.tenantId,
      name: 'K',
      storeIds: [storeA],
      roleKeys: ['Dipakai'],
    });
    expect((await call(owner, 'DELETE', `/${held}`)).status).toBe(422);
    expect((await call(owner, 'DELETE', `/${cashier}`)).status).toBe(422);
    expect(await roleRow(held)).toBeDefined();
  });
});
