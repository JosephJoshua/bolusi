/**
 * "Perangkat" in the visual harness: the real `DevicesScreen` and the real list model over an
 * in-memory stand-in for the server. A block marks the device blocked, as the server's revoke does.
 */
import { StaffAdminError, type RegisteredDevice } from '@bolusi/core';
import { deviceList } from '@bolusi/device/models/devices/model';
import { useMemo, useRef } from 'react';

import { DevicesScreen } from '../screens/settings/DevicesScreen.js';

const NOW = Date.UTC(2026, 10, 25, 2, 30);
const MIN = 60_000;

function device(
  overrides: Partial<RegisteredDevice> & { id: string; name: string },
): RegisteredDevice {
  return {
    storeId: 's-1',
    blocked: false,
    blockedAt: null,
    personalUserId: null,
    lastSyncAt: NOW - 4 * MIN,
    lastSeenAt: NOW - 4 * MIN,
    ...overrides,
  };
}

export const DEVICES_DEMO: readonly RegisteredDevice[] = [
  device({ id: 'd-this', name: 'HP Kasir Depan', lastSyncAt: NOW - MIN }),
  device({ id: 'd-pc', name: 'Komputer Kasir', lastSyncAt: NOW - 2 * MIN }),
  device({
    id: 'd-ani',
    name: 'Samsung A15',
    personalUserId: 'u-ani',
    lastSyncAt: NOW - 3 * 60 * MIN,
  }),
  device({ id: 'd-tech', name: 'HP Teknisi Belakang', lastSyncAt: NOW - 2 * 24 * 60 * MIN }),
  device({ id: 'd-new', name: 'Oppo A58 Gudang', lastSyncAt: null }),
  device({
    id: 'd-lost',
    name: 'HP Kasir Lama',
    blocked: true,
    blockedAt: NOW - 5 * 24 * 60 * MIN,
  }),
];

const NAMES = new Map([['u-ani', 'Ani Koibur']]);

export function DevicesDemo({
  devices = DEVICES_DEMO,
  offline = false,
}: {
  readonly devices?: readonly RegisteredDevice[];
  readonly offline?: boolean;
}): React.JSX.Element {
  const server = useRef(devices.map((d) => ({ ...d })));
  const controls = useMemo(
    () => ({
      load: () =>
        offline
          ? Promise.reject(new StaffAdminError('offline'))
          : Promise.resolve(
              deviceList(server.current, {
                storeId: 's-1',
                thisDeviceId: 'd-this',
                names: NAMES,
                now: NOW,
              }),
            ),
      block: (deviceId: string) => {
        server.current = server.current.map((d) =>
          d.id === deviceId ? { ...d, blocked: true, blockedAt: NOW } : d,
        );
        return Promise.resolve();
      },
    }),
    [offline],
  );
  return <DevicesScreen load={controls.load} onBlock={controls.block} onClose={() => undefined} />;
}
