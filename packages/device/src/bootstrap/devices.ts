// Composes "Perangkat" (owner decision 2026-11-25): the server's list of this store's devices, and
// blocking one, both made as the signed-in owner. Online only, like "Karyawan". NODE-SAFE.
import { StaffAdminError, type StaffAdminPort } from '@bolusi/core';

import { deviceList, type DeviceList } from '../models/devices/model.js';

export interface DeviceControls {
  /** This store's devices, as the server has them now. REJECTS with a `StaffAdminError`. */
  readonly load: () => Promise<DeviceList>;
  /** Block a device; resolves once the server did. REJECTS with a `StaffAdminError`. */
  readonly block: (deviceId: string) => Promise<void>;
}

export interface DeviceControlsDeps {
  readonly port: StaffAdminPort;
  /** The signed-in owner, this device's store and this device; null with no session. */
  readonly context: () => {
    readonly actingUserId: string;
    readonly storeId: string;
    readonly thisDeviceId: string;
  } | null;
  /** The store's people by id, for the phones set up as someone's own. */
  readonly names: () => Promise<ReadonlyMap<string, string>>;
  readonly now: () => number;
}

export function createDeviceControls(deps: DeviceControlsDeps): DeviceControls {
  const context = () => {
    const current = deps.context();
    // Unreachable from the screen (it is behind a session), so never sent anonymously.
    if (current === null) throw new StaffAdminError('denied');
    return current;
  };
  return {
    load: async () => {
      const { actingUserId, storeId, thisDeviceId } = context();
      const [devices, names] = await Promise.all([
        deps.port.listDevices({ actingUserId }),
        deps.names(),
      ]);
      return deviceList(devices, { storeId, thisDeviceId, names, now: deps.now() });
    },
    block: async (deviceId) => {
      const { actingUserId, thisDeviceId } = context();
      // Blocking the device in hand would erase it under the owner; another device does that.
      if (deviceId === thisDeviceId) throw new StaffAdminError('denied');
      await deps.port.blockDevice({ actingUserId, deviceId });
    },
  };
}
