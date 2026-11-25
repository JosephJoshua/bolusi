// Composes "Perangkat" (owner decision 2026-11-25): the server's list of this store's devices, and
// blocking one, both made as the signed-in owner. Online only, like "Karyawan". NODE-SAFE.
import { StaffAdminError, type StaffAdminPort } from '@bolusi/core';

import { deviceList, type DeviceList } from '../models/devices/model.js';

import type { AppSessionController } from './session.js';

export interface DeviceControls {
  /** This store's devices, as the server has them now. REJECTS with a `StaffAdminError`. */
  readonly load: () => Promise<DeviceList>;
  /** Block a device; resolves once the server did. REJECTS with a `StaffAdminError`. */
  readonly block: (deviceId: string) => Promise<void>;
}

export interface DeviceControlsDeps {
  readonly port: StaffAdminPort;
  /** Who acts and for which store, and the store's people (for the phones set up as someone's own). */
  readonly session: Pick<AppSessionController, 'staffContext' | 'listStaff'>;
  /** The device this list is open on. */
  readonly thisDeviceId: string;
  readonly now: () => number;
}

export function createDeviceControls(deps: DeviceControlsDeps): DeviceControls {
  const context = () => {
    const current = deps.session.staffContext();
    // Unreachable from the screen (it is behind a session), so never sent anonymously.
    if (current === null) throw new StaffAdminError('denied');
    return current;
  };
  return {
    load: async () => {
      const { actingUserId, storeId } = context();
      const [devices, directory] = await Promise.all([
        deps.port.listDevices({ actingUserId }),
        deps.session.listStaff(),
      ]);
      const names = new Map(directory.members.map((member) => [member.id, member.name]));
      return deviceList(devices, {
        storeId,
        thisDeviceId: deps.thisDeviceId,
        names,
        now: deps.now(),
      });
    },
    block: async (deviceId) => {
      const { actingUserId } = context();
      // Blocking the device in hand would erase it under the owner; another device does that.
      if (deviceId === deps.thisDeviceId) throw new StaffAdminError('denied');
      await deps.port.blockDevice({ actingUserId, deviceId });
    },
  };
}
