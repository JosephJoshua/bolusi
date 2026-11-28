/**
 * Perlu dicek, the first tab of whoever answers requests: the place they open on, which the other
 * places' back returns to, and which a counter without decisions never sees.
 *
 * Drives the real `Root` with the real repair runtime over the live shell's database.
 */
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
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
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { fire, type RenderResult } from '../../../packages/ui/test/render.js';
import { createSessionRepairRuntime, repairMediaSeamsFor } from '@bolusi/device/bootstrap/repair';
import { __emitHardwareBack, __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  COUNTER_REPAIR_PERMISSIONS,
  enrolledDevice,
  fireOn,
  mountRoot,
  NOTES_PERMISSIONS,
  seedTwoUsers,
  settle,
  submitPin,
  waitUntil,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';

const COUNTER = [...NOTES_PERMISSIONS, ...COUNTER_REPAIR_PERMISSIONS];
const OWNER = [...NOTES_PERMISSIONS, ...Object.values(REPAIR_PERMISSION)];

let fixture: Fixture | null = null;
let screen: RenderResult | null = null;

beforeEach(async () => {
  __resetHardwareBack();
  await closeClientDb();
});

afterEach(async () => {
  screen?.unmount();
  screen = null;
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

async function press(target: RenderResult, testID: string): Promise<void> {
  fire(target.all(testID)[0]!, 'onPress');
  await settle();
}

/** Boot the live shell with the repair surface and sign in, holding `permissions`. */
async function signedIn(permissions: readonly string[]): Promise<RenderResult> {
  const target = await bootFixture();
  fixture = target;
  await enrolledDevice(target);
  await seedTwoUsers(target, 300, permissions);
  const mounted = await mountRoot(target, {
    createRepair: (app, runtime, identity, media, capture) =>
      createSessionRepairRuntime({
        app,
        runtime,
        identity,
        media: repairMediaSeamsFor(media, {
          ...capture,
          loadModelPhoto: () => Promise.reject(new Error('no phone photos in this test')),
        }),
      }),
  });
  screen = mounted;
  fireOn(mounted, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(mounted, TEST_PIN)).toBe(true);
  expect(await waitUntil(() => mounted.query('repair.board.newIntake') !== null)).toBe(true);
  return mounted;
}

function selected(shown: RenderResult, tab: string): boolean {
  return shown.all(`shell-tabs.${tab}`)[0]?.props['accessibilityState']?.selected === true;
}

describe('the Perlu dicek tab', () => {
  test('is not there for the counter, who opens on Servisan', async () => {
    const shown = await signedIn(COUNTER);
    expect(shown.query('shell-tabs.attention')).toBeNull();
    expect(shown.query('attention')).toBeNull();
  });

  test('is where an owner opens, and back from Servisan returns to it', async () => {
    const shown = await signedIn(OWNER);
    expect(await waitUntil(() => shown.query('attention.empty') !== null)).toBe(true);
    expect(selected(shown, 'attention')).toBe(true);

    await press(shown, 'shell-tabs.repair');
    expect(selected(shown, 'repair')).toBe(true);
    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(selected(shown, 'attention')).toBe(true);
    // On the first place, back is the app's own: nothing to return to.
    expect(__emitHardwareBack()).toBe(false);
  });
});
