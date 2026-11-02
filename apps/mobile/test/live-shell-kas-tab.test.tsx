/**
 * The Kas tab beside Servisan: shown to whoever counts the drawer or reads the store's money, and
 * to nobody else. Switching tabs keeps a half-typed intake, and hardware back on Kas goes back to
 * Servisan instead of leaving the app.
 *
 * Drives the real `Root` with the real repair runtime over the live shell's database.
 */
import { MONEY_PERMISSION } from '@bolusi/modules/money';
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
  enrolledDevice,
  fireOn,
  homeShown,
  mountRoot,
  NOTES_PERMISSIONS,
  seedTwoUsers,
  settle,
  submitPin,
  waitUntil,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';

const REPAIR_ONLY = [...NOTES_PERMISSIONS, ...Object.values(REPAIR_PERMISSION)];
const COUNTER = [
  ...REPAIR_ONLY,
  MONEY_PERMISSION.read,
  MONEY_PERMISSION.receive,
  MONEY_PERMISSION.moveCash,
  MONEY_PERMISSION.countCash,
];

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

describe('the Kas tab', () => {
  test('is not there for someone without the store money', async () => {
    const shown = await signedIn(REPAIR_ONLY);
    expect(shown.query('shell-tabs')).toBeNull();
  });

  test('opens the drawer, and a half-typed intake is still there on Servisan', async () => {
    const shown = await signedIn(COUNTER);
    await press(shown, 'repair.board.newIntake');
    fire(shown.get('repair.intake.customer.name.field'), 'onChangeText', 'Yohanis Wenda');
    await settle();

    await press(shown, 'shell-tabs.kas');
    expect(await waitUntil(() => shown.query('money.kas.drawer') !== null)).toBe(true);
    expect(homeShown(shown)).toBe(true);

    await press(shown, 'shell-tabs.repair');
    expect(shown.get('repair.intake.customer.name.field').props['value']).toBe('Yohanis Wenda');
  });

  test('switching user from Kas first shows the half-typed intake and asks there', async () => {
    const shown = await signedIn(COUNTER);
    await press(shown, 'repair.board.newIntake');
    fire(shown.get('repair.intake.customer.name.field'), 'onChangeText', 'Yohanis Wenda');
    await settle();
    await press(shown, 'shell-tabs.kas');
    await waitUntil(() => shown.query('money.kas.drawer') !== null);

    fire(shown.all('ui.avatarButton').at(-1)!, 'onPress');
    await settle();
    await press(shown, 'account-menu-switch-user');

    expect(shown.query('money.kas')).toBeNull();
    expect(shown.query('repair.intake.discard')).not.toBeNull();
    expect(shown.query('switcher-screen')).toBeNull();
  });

  test('hardware back on Kas goes to Servisan, and from a Kas step (without tabs) back to the board', async () => {
    const shown = await signedIn(COUNTER);
    await press(shown, 'shell-tabs.kas');
    await waitUntil(() => shown.query('money.kas.count') !== null);
    await press(shown, 'money.kas.count');
    expect(shown.query('money.count')).not.toBeNull();
    // A step keeps what was typed only while it shows: no tabs to leave it by.
    expect(shown.query('shell-tabs')).toBeNull();

    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.query('money.count')).toBeNull();
    expect(shown.query('money.kas')).not.toBeNull();
    expect(shown.query('shell-tabs')).not.toBeNull();

    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.all('shell-tabs.repair')[0]!.props['accessibilityState']).toEqual({
      selected: true,
    });
  });
});

describe('payment methods in Settings', () => {
  async function openSettings(shown: RenderResult): Promise<void> {
    await press(shown, 'ui.avatarButton');
    await press(shown, 'shell-open-settings');
    expect(await waitUntil(() => shown.query('settings-section-language') !== null)).toBe(true);
  }

  test('are for whoever manages the store’s accounts, and back returns to Settings', async () => {
    const shown = await signedIn([...COUNTER, MONEY_PERMISSION.manageAccounts]);
    await openSettings(shown);
    await press(shown, 'settings-payment-methods');
    expect(await waitUntil(() => shown.query('money.methods.cash') !== null)).toBe(true);

    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.query('money.methods')).toBeNull();
    expect(shown.query('settings-payment-methods')).not.toBeNull();
  });

  test('are not there for the counter', async () => {
    const shown = await signedIn(COUNTER);
    await openSettings(shown);
    expect(shown.query('settings-payment-methods')).toBeNull();
    expect(shown.query('settings-section-money')).toBeNull();
  });
});
