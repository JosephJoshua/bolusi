// "Perangkat" composition: the list and a block are made as the signed-in owner, and this device
// can never block itself from here.
import { StaffAdminError, staffAdminFailure, type StaffAdminPort } from '@bolusi/core';
import { describe, expect, test, vi } from 'vitest';

import { createDeviceControls } from './devices.js';

function port(): StaffAdminPort {
  return {
    listDevices: vi.fn(() =>
      Promise.resolve([
        {
          id: 'd-1',
          name: 'HP Ani',
          storeId: 's-1',
          blocked: false,
          blockedAt: null,
          personalUserId: 'u-ani',
          lastSyncAt: 1,
          lastSeenAt: 1,
        },
      ]),
    ),
    blockDevice: vi.fn(() => Promise.resolve()),
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

const CONTEXT = { actingUserId: 'u-owner', storeId: 's-1', thisDeviceId: 'd-this' };

describe('createDeviceControls', () => {
  test('loads as the owner and names the personal phones', async () => {
    const admin = port();
    const controls = createDeviceControls({
      port: admin,
      context: () => CONTEXT,
      names: () => Promise.resolve(new Map([['u-ani', 'Ani']])),
      now: () => 2,
    });
    const list = await controls.load();
    expect(admin.listDevices).toHaveBeenCalledWith({ actingUserId: 'u-owner' });
    expect(list.active[0]?.detail).toMatch(/^HP pribadi Ani/);
  });

  test('blocks as the owner, and refuses this device without asking the server', async () => {
    const admin = port();
    const controls = createDeviceControls({
      port: admin,
      context: () => CONTEXT,
      names: () => Promise.resolve(new Map()),
      now: () => 0,
    });
    await controls.block('d-1');
    expect(admin.blockDevice).toHaveBeenCalledWith({ actingUserId: 'u-owner', deviceId: 'd-1' });

    const refused = await controls.block('d-this').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StaffAdminError);
    expect(staffAdminFailure(refused)).toBe('denied');
    expect(admin.blockDevice).toHaveBeenCalledTimes(1);
  });

  test('with no session nothing is sent', async () => {
    const admin = port();
    const controls = createDeviceControls({
      port: admin,
      context: () => null,
      names: () => Promise.resolve(new Map()),
      now: () => 0,
    });
    await expect(controls.load()).rejects.toBeInstanceOf(StaffAdminError);
    await expect(controls.block('d-1')).rejects.toBeInstanceOf(StaffAdminError);
    expect(admin.listDevices).not.toHaveBeenCalled();
    expect(admin.blockDevice).not.toHaveBeenCalled();
  });
});
