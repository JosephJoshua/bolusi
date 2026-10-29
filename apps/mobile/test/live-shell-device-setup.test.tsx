/**
 * The new-phone setup in the LIVE shell: the owner who registered the phone gets it on their first
 * unlock, with the camera and notification permissions asked up front instead of the notification
 * sheet (which then does not ask again); finishing or putting it off marks it done in the device's own meta, and Settings opens it
 * again.
 */
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
  getExpoPushTokenAsync: vi.fn(async () => ({
    data: 'ExponentPushToken[setup]',
    type: 'expo' as const,
  })),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import {
  markDeviceSetupPending,
  readDeviceSetupFor,
  readMeta,
  DEVICE_SETUP_META_KEY,
} from '@bolusi/core';

import type { NotificationPermissionPort, PermissionPort } from '../src/push/permission.js';
import {
  bootFixture,
  enrolledDevice,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';
import { __emitAppState, __emitHardwareBack, __resetHardwareBack } from './doubles/react-native.js';
import type { RenderResult } from '../../../packages/ui/test/render.js';

let fixture: Fixture | null = null;
afterEach(async () => {
  __resetHardwareBack();
  await fixture?.close();
  fixture = null;
});

function fakePermission(initial: { granted: boolean; canAskAgain: boolean }) {
  const calls: string[] = [];
  let answer = initial;
  const port: PermissionPort = {
    status: async () => answer,
    request: async () => {
      calls.push('request');
      answer = { granted: true, canAskAgain: true };
    },
  };
  return {
    port,
    calls,
    set: (next: { granted: boolean; canAskAgain: boolean }) => {
      answer = next;
    },
  };
}

function notificationPort(base: PermissionPort): NotificationPermissionPort {
  let asked = false;
  return {
    ...base,
    readAsked: async () => asked,
    writeAsked: async () => {
      asked = true;
    },
  };
}

async function unlock(
  target: Fixture,
  options: Parameters<typeof mountRoot>[1],
  pending: boolean,
): Promise<RenderResult> {
  await enrolledDevice(target);
  await seedDirectory(target);
  if (pending) await markDeviceSetupPending(target.app.db.db, target.userId);
  const screen = await mountRoot(target, options);
  fireOn(screen, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(screen, TEST_PIN)).toBe(true);
  return screen;
}

describe('setting up a newly registered phone', () => {
  test('asks the permissions up front, then marks the setup done', async () => {
    fixture = await bootFixture();
    const camera = fakePermission({ granted: false, canAskAgain: true });
    const notifications = fakePermission({ granted: false, canAskAgain: false });
    const screen = await unlock(
      fixture,
      {
        cameraPermission: camera.port,
        notificationPermission: notificationPort(notifications.port),
      },
      true,
    );
    expect(await waitUntil(() => screen.query('setup.permissions') !== null)).toBe(true);
    // The setup asks with its own reasons: no notification sheet over it.
    expect(screen.query('notification-ask')).toBeNull();
    expect(await waitUntil(() => screen.query('setup.camera.allow') !== null)).toBe(true);
    // Refused for good: only the phone's settings can turn it on.
    expect(await waitUntil(() => screen.query('setup.notifications.settings') !== null)).toBe(true);

    fireOn(screen, 'setup.camera.allow');
    expect(await waitUntil(() => screen.query('setup.camera.allowed') !== null)).toBe(true);
    expect(camera.calls).toEqual(['request']);

    // Back from the phone's settings with notifications on: read again.
    notifications.set({ granted: true, canAskAgain: true });
    await act(async () => __emitAppState('active'));
    expect(await waitUntil(() => screen.query('setup.notifications.allowed') !== null)).toBe(true);

    fireOn(screen, 'setup.next');
    expect(await waitUntil(() => screen.query('setup.done') !== null)).toBe(true);
    expect(await readDeviceSetupFor(fixture.app.db.db)).toBe(fixture.userId);
    // The phone's back goes one step back, like the header's, without ending the setup.
    let consumed = false;
    await act(async () => {
      consumed = __emitHardwareBack();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(consumed).toBe(true);
    expect(await waitUntil(() => screen.query('setup.permissions') !== null)).toBe(true);
    expect(await readDeviceSetupFor(fixture.app.db.db)).toBe(fixture.userId);
    fireOn(screen, 'setup.next');
    expect(await waitUntil(() => screen.query('setup.done') !== null)).toBe(true);
    fireOn(screen, 'setup.start');
    expect(await waitUntil(() => screen.query('notes.list.title') !== null)).toBe(true);
    expect(
      await waitUntil(
        async () => (await readMeta(fixture!.app.db.db, DEVICE_SETUP_META_KEY)) === 'done',
      ),
    ).toBe(true);
  });

  test('can be put off without the notification sheet asking again, and Settings opens it again', async () => {
    fixture = await bootFixture();
    const notifications = fakePermission({ granted: false, canAskAgain: true });
    const screen = await unlock(
      fixture,
      { notificationPermission: notificationPort(notifications.port) },
      true,
    );
    expect(await waitUntil(() => screen.query('setup.permissions') !== null)).toBe(true);
    fireOn(screen, 'setup.later');
    expect(await waitUntil(() => screen.query('notes.list.title') !== null)).toBe(true);
    expect(await readDeviceSetupFor(fixture.app.db.db)).toBeNull();
    // The setup already showed why notifications matter: the sheet does not repeat it.
    await settle();
    expect(screen.query('notification-ask')).toBeNull();

    fireOn(screen, 'ui.avatarButton');
    await settle();
    fireOn(screen, 'shell-open-settings');
    await settle();
    fireOn(screen, 'settings-setup');
    expect(await waitUntil(() => screen.query('setup.permissions') !== null)).toBe(true);
    // Reopened from Settings, it ends back in Settings.
    fireOn(screen, 'setup.later');
    expect(await waitUntil(() => screen.query('settings-screen') !== null)).toBe(true);
  });

  test('stays out of the way on a phone that was set up, or registered before setup existed', async () => {
    fixture = await bootFixture();
    const screen = await unlock(fixture, {}, false);
    expect(await waitUntil(() => screen.query('notes.list.title') !== null)).toBe(true);
    expect(screen.query('setup.permissions')).toBeNull();
  });
});
