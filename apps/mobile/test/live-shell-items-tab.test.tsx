/**
 * The Barang tab: the store's stock, with Belanja beside it for whoever buys from suppliers. Shown
 * to whoever may read the stock and to nobody else; the tabs give way to an open form, and hardware
 * back closes the form first, then returns to Servisan instead of leaving the app.
 *
 * Drives the real `Root` with the real repair runtime over the live shell's database.
 */
import { INVENTORY_PERMISSION } from '@bolusi/modules/inventory';
import { PURCHASING_PERMISSION } from '@bolusi/modules/purchasing';
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

const REPAIR_ONLY = [...NOTES_PERMISSIONS, ...COUNTER_REPAIR_PERMISSIONS];
/** A technician: reads the stock, adds nothing to it, buys nothing. */
const READS_STOCK = [...REPAIR_ONLY, INVENTORY_PERMISSION.read];
/** A store owner: keeps the stock and buys from suppliers. */
const KEEPS_AND_BUYS = [
  ...REPAIR_ONLY,
  INVENTORY_PERMISSION.read,
  INVENTORY_PERMISSION.manageItems,
  PURCHASING_PERMISSION.buy,
];
/** An owner who also sets up the categories. */
const SETS_UP = [...KEEPS_AND_BUYS, INVENTORY_PERMISSION.manageCategories];

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
async function signedIn(
  permissions: readonly string[],
  scope: 'store' | 'tenant' = 'store',
): Promise<RenderResult> {
  const target = await bootFixture();
  fixture = target;
  await enrolledDevice(target);
  await seedTwoUsers(target, 300, permissions, scope);
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

const selected = (shown: RenderResult, testID: string): unknown =>
  shown.all(testID)[0]!.props['accessibilityState'];

describe('the Barang tab', () => {
  test('is not there for someone who may not read the stock', async () => {
    const shown = await signedIn(REPAIR_ONLY);
    expect(shown.query('shell-tabs')).toBeNull();
  });

  test('shows a technician the stock alone, with no Belanja and no back arrow', async () => {
    const shown = await signedIn(READS_STOCK);
    await press(shown, 'shell-tabs.items');
    expect(await waitUntil(() => shown.query('inventory.list') !== null)).toBe(true);
    expect(shown.query('items.sections')).toBeNull();
    expect(shown.query('inventory.list.back')).toBeNull();
    // Nothing of it is left in the account menu.
    await press(shown, 'ui.avatarButton');
    expect(shown.query('shell-open-parts')).toBeNull();
    expect(shown.query('shell-open-purchasing')).toBeNull();
  });

  test('switches between Stok and Belanja for whoever buys, keeping each as it was', async () => {
    const shown = await signedIn(KEEPS_AND_BUYS);
    await press(shown, 'shell-tabs.items');
    expect(await waitUntil(() => shown.query('inventory.list') !== null)).toBe(true);
    await press(shown, 'items.sections.orders');
    expect(await waitUntil(() => shown.query('purchasing.orders') !== null)).toBe(true);
    expect(selected(shown, 'items.sections.orders')).toMatchObject({ selected: true });
    // Servisan and back: Barang is still on Belanja.
    await press(shown, 'shell-tabs.repair');
    await press(shown, 'shell-tabs.items');
    expect(selected(shown, 'items.sections.orders')).toMatchObject({ selected: true });
  });

  test('gives an open form the whole screen; hardware back closes it, then goes to Servisan', async () => {
    const shown = await signedIn(KEEPS_AND_BUYS);
    await press(shown, 'shell-tabs.items');
    await waitUntil(() => shown.query('inventory.list.add') !== null);
    await press(shown, 'inventory.list.add');
    expect(shown.query('inventory.form')).not.toBeNull();
    expect(shown.query('shell-tabs')).toBeNull();

    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.query('inventory.form')).toBeNull();
    expect(shown.query('inventory.list')).not.toBeNull();
    expect(shown.query('shell-tabs')).not.toBeNull();

    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(selected(shown, 'shell-tabs.repair')).toEqual({ selected: true });
  });

  test('keeps category setup out of the chip row: it opens from the filters and backs out to them', async () => {
    const shown = await signedIn(SETS_UP, 'tenant');
    await press(shown, 'shell-tabs.items');
    await waitUntil(() => shown.query('inventory.list.filter') !== null);
    expect(shown.query('inventory.list.categories')).toBeNull();
    await press(shown, 'inventory.list.filter');
    expect(shown.query('inventory.filterStep')).not.toBeNull();
    await press(shown, 'inventory.filterStep.categories');
    expect(shown.query('inventory.categories')).not.toBeNull();
    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.query('inventory.filterStep')).not.toBeNull();
  });

  test('offers no category setup to whoever may not set it up', async () => {
    const shown = await signedIn(KEEPS_AND_BUYS);
    await press(shown, 'shell-tabs.items');
    await waitUntil(() => shown.query('inventory.list.filter') !== null);
    await press(shown, 'inventory.list.filter');
    expect(shown.query('inventory.filterStep')).not.toBeNull();
    expect(shown.query('inventory.filterStep.categories')).toBeNull();
  });
});
