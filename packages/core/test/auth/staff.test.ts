// Staff management's shared rules (owner decision 2026-10-27): the directory as the owner sees it,
// which roles and people an owner may manage, and draft checks. Real client DB, seeded the way a
// device is, through `applyBundle`.
import { CamelCasePlugin, Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import { openMemoryDriver } from '@bolusi/sqlite-test-driver';

import {
  applyBundle,
  canManageMember,
  grantableRoles,
  mayManageOwnerPin,
  readStaffDirectory,
  resolveDisplayRoleKeys,
  settableLimitRoles,
  staffAdminFailure,
  StaffAdminError,
  staffDraftProblem,
  STORE_ID_META_KEY,
  writeMeta,
  type BundleUser,
  type DeviceBundle,
  type StaffMember,
} from '../../src/index.js';

const STORE = 'store-1';

function user(
  id: string,
  name: string,
  roleIds: string[],
  status: 'active' | 'deactivated' = 'active',
): BundleUser {
  return {
    id,
    name,
    photoMediaId: null,
    status,
    grants: roleIds.map((roleId) => ({
      roleId,
      storeId: roleId === 'r-main' ? null : STORE,
    })),
    pinVerifier: null,
  };
}

const ROLES: DeviceBundle['rolesSnapshot'] = [
  {
    id: 'r-main',
    name: 'main_owner',
    scopeType: 'tenant',
    isSystemDefault: true,
    permissionIds: ['auth.user_create', 'auth.role_manage'],
  },
  {
    id: 'r-store',
    name: 'store_owner',
    scopeType: 'store',
    isSystemDefault: true,
    permissionIds: ['auth.user_create', 'repair.read'],
  },
  {
    id: 'r-cashier',
    name: 'cashier',
    scopeType: 'store',
    isSystemDefault: true,
    permissionIds: ['repair.read', 'repair.intake'],
  },
  {
    id: 'r-tech',
    name: 'technician',
    scopeType: 'store',
    isSystemDefault: true,
    permissionIds: ['repair.read', 'repair.work'],
  },
  {
    id: 'r-manager',
    name: 'manager',
    scopeType: 'store',
    isSystemDefault: true,
    permissionIds: ['repair.read', 'repair.discount'],
    limits: { priceDrop: 50_000, refund: 0, credit: 100_000 },
  },
  {
    id: 'r-staff',
    name: 'staff',
    scopeType: 'store',
    isSystemDefault: true,
    permissionIds: ['notes.read'],
  },
];

let close: (() => Promise<void>) | null = null;

async function seeded(users: BundleUser[]): Promise<Kysely<ClientDatabase>> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  close = async () => {
    await db.destroy();
    await driver.close();
  };
  await applyBundle(db, {
    tenant: { id: 'tenant-1', name: 'T' },
    store: { id: STORE, name: 'S' },
    settings: { idleLockSeconds: 300 },
    users,
    rolesSnapshot: ROLES,
    permissionsSnapshot: [],
  });
  return db;
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe('readStaffDirectory', () => {
  it('lists everyone with all their roles, active first, and only the pickable roles', async () => {
    const db = await seeded([
      user('u-owner', 'Ocep', ['r-main']),
      user('u-zed', 'Zed', ['r-tech', 'r-cashier']),
      user('u-ana', 'Ana', ['r-cashier'], 'deactivated'),
      user('u-budi', 'Budi', ['r-store']),
    ]);
    const directory = await readStaffDirectory(db);

    expect(directory.roles.map((role) => [role.key, role.ownerRole])).toEqual([
      ['cashier', false],
      ['technician', false],
      ['manager', false],
      ['store_owner', true],
    ]);
    expect(directory.members.map((m) => [m.name, m.active, m.owner, m.roleKeys.join('+')])).toEqual(
      [
        ['Budi', true, true, 'store_owner'],
        ['Ocep', true, true, 'main_owner'],
        // Both roles, in offer order, not just the "top" one the switcher shows.
        ['Zed', true, false, 'cashier+technician'],
        ['Ana', false, false, 'cashier'],
      ],
    );
    // Nobody in this bundle carries a PIN yet.
    expect(directory.members.every((m) => !m.hasPin)).toBe(true);
  });
});

describe('an owner at another store', () => {
  it('is an owner here too, though the roles shown are the ones held here', async () => {
    const elsewhere: BundleUser = {
      ...user('u-both', 'Ana', ['r-cashier']),
      // The bundle carries an owner-role grant at another store, as the server judges owners there.
      grants: [
        { roleId: 'r-cashier', storeId: STORE },
        { roleId: 'r-store', storeId: 'store-2' },
      ],
    };
    const db = await seeded([user('u-so', 'Budi', ['r-store']), elsewhere]);
    await writeMeta(db, STORE_ID_META_KEY, STORE);

    const ana = (await readStaffDirectory(db)).members.find((m) => m.id === 'u-both');
    expect(ana).toMatchObject({ owner: true, roleKeys: ['cashier'], roleIds: ['r-cashier'] });
    expect(await resolveDisplayRoleKeys(db, 'u-both')).toEqual(['cashier']);
    // This store's owner is not offered her PIN, which the server would refuse.
    expect(await mayManageOwnerPin(db, 'u-so', 'u-both')).toBe(false);
  });
});

describe('limited roles', () => {
  it('reads a limited role’s amounts here; a role free of limits has none', async () => {
    const { roles } = await readStaffDirectory(await seeded([]));
    expect(roles.find((role) => role.key === 'manager')?.limits).toEqual({
      priceDrop: 50_000,
      refund: 0,
      credit: 100_000,
    });
    expect(roles.find((role) => role.key === 'cashier')?.limits).toBeNull();
  });

  it('an owner sets a limited role’s amounts, but never one they hold themselves', async () => {
    const directory = await readStaffDirectory(
      await seeded([
        user('u-so', 'Budi', ['r-store']),
        user('u-both', 'Ana', ['r-store', 'r-manager']),
      ]),
    );
    expect(
      settableLimitRoles(directory, { userId: 'u-so', tenantAdmin: false }).map((r) => r.key),
    ).toEqual(['manager']);
    expect(settableLimitRoles(directory, { userId: 'u-both', tenantAdmin: false })).toEqual([]);
  });
});

describe('who may manage what', () => {
  const member = (over: Partial<StaffMember>): StaffMember => ({
    id: 'u-1',
    name: 'Rina',
    active: true,
    roleKeys: ['cashier'],
    roleIds: ['r-cashier'],
    owner: false,
    hasPin: true,
    ...over,
  });
  const storeOwner = { userId: 'u-so', tenantAdmin: false };
  const mainOwner = { userId: 'u-main', tenantAdmin: true };

  it('offers owner roles only to a main owner', async () => {
    const db = await seeded([]);
    const { roles } = await readStaffDirectory(db);
    expect(grantableRoles(roles, storeOwner).map((r) => r.key)).toEqual([
      'cashier',
      'technician',
      'manager',
    ]);
    expect(grantableRoles(roles, mainOwner).map((r) => r.key)).toEqual([
      'cashier',
      'technician',
      'manager',
      'store_owner',
    ]);
  });

  it('a store owner manages staff but not owners or themselves; a main owner manages owners', () => {
    expect(canManageMember(member({}), storeOwner)).toBe(true);
    expect(canManageMember(member({ owner: true }), storeOwner)).toBe(false);
    expect(canManageMember(member({ id: 'u-so', owner: true }), storeOwner)).toBe(false);
    expect(canManageMember(member({ owner: true }), mainOwner)).toBe(true);
    expect(canManageMember(member({ id: 'u-main', owner: true }), mainOwner)).toBe(false);
  });
});

describe('staffDraftProblem', () => {
  const members = [
    {
      id: 'u-1',
      name: 'Rina',
      active: true,
      roleKeys: [],
      roleIds: [],
      owner: false,
      hasPin: true,
    },
    {
      id: 'u-2',
      name: 'Budi ',
      active: false,
      roleKeys: [],
      roleIds: [],
      owner: false,
      hasPin: true,
    },
  ];

  it('checks the name, then the roles', () => {
    expect(staffDraftProblem({ name: '  ', roleIds: ['r'] }, members, null)).toBe('nameMissing');
    expect(staffDraftProblem({ name: 'x'.repeat(65), roleIds: ['r'] }, members, null)).toBe(
      'nameTooLong',
    );
    expect(staffDraftProblem({ name: 'Dewi', roleIds: [] }, members, null)).toBe('roleMissing');
    expect(staffDraftProblem({ name: ' Dewi ', roleIds: ['r'] }, members, null)).toBeNull();
  });

  it('refuses a name someone else here already has, active or not, ignoring case', () => {
    expect(staffDraftProblem({ name: 'rina', roleIds: ['r'] }, members, null)).toBe('nameTaken');
    expect(staffDraftProblem({ name: 'BUDI', roleIds: ['r'] }, members, null)).toBe('nameTaken');
    // Keeping your own name while editing is fine.
    expect(staffDraftProblem({ name: 'Rina', roleIds: ['r'] }, members, 'u-1')).toBeNull();
  });
});

it('staffAdminFailure reads the reason, and calls anything else unexpected', () => {
  expect(staffAdminFailure(new StaffAdminError('offline'))).toBe('offline');
  expect(staffAdminFailure(new Error('boom'))).toBe('unexpected');
});
