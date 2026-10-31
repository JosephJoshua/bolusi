// The staff composition: every change is made as the signed-in owner for this device's store, and the
// directory is refreshed after the server took it, so "Karyawan" re-reads the server's answer.
import { StaffAdminError, staffAdminFailure, type StaffAdminPort } from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { createStaffControls } from './staff.js';

function port(): StaffAdminPort {
  return {
    create: vi.fn(() => Promise.resolve({ userId: 'u-new' })),
    update: vi.fn(() => Promise.resolve()),
    setActive: vi.fn(() => Promise.resolve()),
    setLimits: vi.fn(() => Promise.resolve()),
    renameDevice: vi.fn(() => Promise.resolve()),
    createRole: vi.fn(() => Promise.resolve({ roleId: 'r-new' })),
    updateRole: vi.fn(() => Promise.resolve()),
    deleteRole: vi.fn(() => Promise.resolve()),
  };
}

const EMPTY = { roles: [], members: [] };

describe('createStaffControls', () => {
  test('acts as the signed-in owner in this store, then refreshes the directory', async () => {
    const admin = port();
    const order: string[] = [];
    vi.mocked(admin.create).mockImplementation(() => {
      order.push('server');
      return Promise.resolve({ userId: 'u-new' });
    });
    const controls = createStaffControls({
      port: admin,
      tenantAdmin: false,
      canSetLimits: false,
      load: () => Promise.resolve(EMPTY),
      context: () => ({ actingUserId: 'u-owner', storeId: 's-1' }),
      refreshDirectory: () => {
        order.push('refresh');
        return Promise.resolve();
      },
    });

    await expect(controls.onCreate({ name: 'Rina', roleIds: ['r-cashier'] })).resolves.toEqual({
      userId: 'u-new',
    });
    expect(admin.create).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      storeId: 's-1',
      name: 'Rina',
      roleIds: ['r-cashier'],
    });
    expect(order).toEqual(['server', 'refresh']);

    await controls.onUpdate('u-1', { roleIds: ['r-tech'] });
    expect(admin.update).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      userId: 'u-1',
      roleIds: ['r-tech'],
    });
    await controls.onSetActive('u-1', false);
    expect(admin.setActive).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      userId: 'u-1',
      active: false,
    });

    const limits = { priceDrop: 50_000, refund: 0, credit: 100_000 };
    await controls.onSetLimits('r-manager', limits);
    expect(admin.setLimits).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      storeId: 's-1',
      roleId: 'r-manager',
      limits,
    });
    expect(order).toEqual(['server', 'refresh', 'refresh', 'refresh', 'refresh']);

    await expect(controls.onCreateRole('Kasir senior', 'r-cashier')).resolves.toEqual({
      roleId: 'r-new',
    });
    expect(admin.createRole).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      name: 'Kasir senior',
      copyFromRoleId: 'r-cashier',
    });
    await controls.onUpdateRole('r-new', { limited: true });
    expect(admin.updateRole).toHaveBeenCalledWith({
      actingUserId: 'u-owner',
      roleId: 'r-new',
      limited: true,
    });
    await controls.onDeleteRole('r-new');
    expect(admin.deleteRole).toHaveBeenCalledWith({ actingUserId: 'u-owner', roleId: 'r-new' });
    expect(order.filter((step) => step === 'refresh')).toHaveLength(7);
  });

  test('a refused change is not followed by a refresh, and a failed refresh does not undo a change', async () => {
    const admin = port();
    vi.mocked(admin.update).mockRejectedValueOnce(new StaffAdminError('offline'));
    const refreshDirectory = vi.fn(() => Promise.reject(new Error('sync down')));
    const controls = createStaffControls({
      port: admin,
      tenantAdmin: true,
      canSetLimits: true,
      load: () => Promise.resolve(EMPTY),
      context: () => ({ actingUserId: 'u-owner', storeId: 's-1' }),
      refreshDirectory,
    });

    const refused = await controls.onUpdate('u-1', { name: 'X' }).catch((e: unknown) => e);
    expect(staffAdminFailure(refused)).toBe('offline');
    expect(refreshDirectory).not.toHaveBeenCalled();

    await expect(controls.onSetActive('u-1', true)).resolves.toBeUndefined();
    expect(refreshDirectory).toHaveBeenCalledTimes(1);
  });

  test('with nobody signed in nothing is sent', async () => {
    const admin = port();
    const controls = createStaffControls({
      port: admin,
      tenantAdmin: false,
      canSetLimits: false,
      load: () => Promise.resolve(EMPTY),
      context: () => null,
      refreshDirectory: () => Promise.resolve(),
    });
    await expect(controls.onSetActive('u-1', false)).rejects.toBeInstanceOf(StaffAdminError);
    expect(admin.setActive).not.toHaveBeenCalled();
  });
});
