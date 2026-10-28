/**
 * Android recreating the activity in the same process (the "Fix blank screen after Android relaunch"
 * QA finding). "Don't keep activities", backing out and relaunching from the launcher, or memory
 * pressure destroys the activity while the JS realm lives on, so React unmounts `Root` and mounts it
 * again. The first boot's op-sqlite connection is still open, and a second `bootstrap()` threw
 * `already_open`; Root's gate then rendered nothing until a force-stop.
 *
 * These tests mount the real `Root` over the real data layer through `bootOncePerRealm`, the wrapper
 * index.ts boots through, and remount it with nothing closed in between, as Android does.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[recreate]', type: 'expo' })),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { bootOncePerRealm } from '@bolusi/device/bootstrap/bootstrap';
import { Root, type RootProps } from '../src/bootstrap/Root.js';
import {
  bootAt,
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fakeAppState,
  manualTimer,
  settle,
  type Fixture,
} from './live-shell-support.js';
import { render } from '../../../packages/ui/test/render.js';

let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

function rootProps(boot: RootProps['boot']): RootProps {
  return {
    localeStore: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
    boot,
    readDeviceInfo: (app) =>
      Promise.resolve({
        deviceId: app.deviceId ?? '',
        deviceName: 'Konter Depan',
        storeName: 'Servis Ponsel Maju',
        tenantName: 'Maju Group',
        platform: 'android',
        appVersion: '0.0.0-test',
      }),
    appState: fakeAppState(),
    timer: manualTimer(),
  };
}

describe('Android recreates the activity in the same process', () => {
  test('a remounted Root renders the shell again instead of a blank screen', async () => {
    fixture = await bootFixture();
    await closeClientDb(); // Root opens the database itself, as on a device.
    const location = fixture.location;
    const boot = bootOncePerRealm(() => bootAt(location));

    const first = render(<Root {...rootProps(boot)} />);
    await settle();
    expect(first.query('root-activity')).not.toBeNull();

    // The activity is destroyed; the JS realm and its open connection are not.
    first.unmount();

    const second = render(<Root {...rootProps(boot)} />);
    await settle();
    expect(second.query('root-activity')).not.toBeNull();
    second.unmount();
  });

  test('a remount sees an enrollment that happened after the first boot', async () => {
    fixture = await bootFixture();
    await closeClientDb();
    const target = fixture;
    const boot = bootOncePerRealm(() => bootAt(target.location));

    const firstBoot = await boot();
    expect(firstBoot.deviceId).toBeNull();

    target.app = firstBoot;
    await enrolledDevice(target);

    const remountBoot = await boot();
    expect(remountBoot.db).toBe(firstBoot.db);
    expect(remountBoot.deviceId).toBe(target.deviceId);
  });

  test('a failed boot is not kept, so the next mount retries it', async () => {
    fixture = await bootFixture();
    await closeClientDb();
    const location = fixture.location;
    let calls = 0;
    const boot = bootOncePerRealm(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('transient')) : bootAt(location);
    });

    await expect(boot()).rejects.toThrow('transient');
    const app = await boot();
    expect(app.deviceId).toBeNull();
    expect(calls).toBe(2);
  });
});
