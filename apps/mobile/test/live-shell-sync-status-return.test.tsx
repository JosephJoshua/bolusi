/**
 * Checking sync from an open servisan comes back to exactly where the person was: the ticket, the
 * step on it and what was typed into that step. Sync Status used to replace the home surface, so the
 * repair screens unmounted and Back landed on the board with the typing gone (tablet QA, PR #53).
 *
 * Drives the real `Root` with the real repair runtime over the live shell's database.
 */
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
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
import { createSessionRepairRuntime, repairMediaSeamsFor } from '../src/bootstrap/repair.js';
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

const COUNTER_PERMISSIONS = [...NOTES_PERMISSIONS, ...Object.values(REPAIR_PERMISSION)];
const REASON = 'Baterai kembung, pelanggan setuju lewat telepon';

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

function photoRef(target: Fixture, n: number) {
  return {
    mediaId: `01920000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
    sha256: n.toString(16).padStart(64, '0'),
    mime: 'image/jpeg',
    type: 'image',
    sizeBytes: 120_000,
    capturedAt: 1,
    location: null,
    userId: target.userId,
    deviceId: target.deviceId,
  };
}

async function press(target: RenderResult, testID: string): Promise<void> {
  fire(target.all(testID)[0]!, 'onPress');
  await settle();
}

function reasonField(target: RenderResult): { readonly props: Record<string, unknown> } | null {
  return target.query('repair.price.change.reason.field');
}

/** Boot the live shell with the repair surface and sign in with the real PIN. */
async function signedIn(): Promise<{
  readonly target: Fixture;
  readonly mounted: RenderResult;
  readonly repair: RepairRuntime;
}> {
  const target = await bootFixture();
  fixture = target;
  await enrolledDevice(target);
  await seedTwoUsers(target, 300, COUNTER_PERMISSIONS);
  let repair: RepairRuntime | null = null;
  const mounted = await mountRoot(target, {
    createRepair: (app, runtime, identity, media, capture) => {
      repair = createSessionRepairRuntime({
        app,
        runtime,
        identity,
        media: repairMediaSeamsFor(media, {
          ...capture,
          loadModelPhoto: () => Promise.reject(new Error('no phone photos in this test')),
        }),
      });
      return repair;
    },
  });
  screen = mounted;
  fireOn(mounted, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(mounted, TEST_PIN)).toBe(true);
  expect(await waitUntil(() => mounted.query('repair.board.newIntake') !== null)).toBe(true);
  return { target, mounted, repair: repair! };
}

/** Sign in, open a servisan and open Ubah harga with a reason typed into it. */
async function openStepWithTyping(): Promise<RenderResult> {
  const { target, mounted, repair } = await signedIn();
  const opened = (await repair.run('openTicket', {
    customer: { name: 'Yohanis Wenda', phone: '0812-4455-6677' },
    device: { brand: 'Samsung', model: 'Galaxy A14', color: 'Hitam', imei: '356789104455667' },
    complaint: 'Baterai cepat habis',
    checklist: [],
    peripherals: [],
    quoteLines: [{ kind: 'labour', description: 'Cek baterai', amount: 50_000 }],
    photos: ['front', 'back', 'left', 'right', 'top', 'bottom'].map((slot, i) => ({
      slot,
      label: null,
      ref: photoRef(target, i + 1),
    })),
  } as never)) as { ticketId: string };
  const row = `repair.board.row.${opened.ticketId}`;
  expect(await waitUntil(() => mounted.query(row) !== null)).toBe(true);
  await press(mounted, row);
  await waitUntil(() => mounted.query('repair.ticket.action.changePrice') !== null);
  await press(mounted, 'repair.ticket.action.changePrice');
  fire(mounted.get('repair.price.change.reason.field'), 'onChangeText', REASON);
  await settle();
  expect(reasonField(mounted)?.props['value']).toBe(REASON);
  return mounted;
}

describe('checking sync from an open servisan keeps it open', () => {
  test('the header back returns to the same step with the typing intact', async () => {
    const shown = await openStepWithTyping();

    await press(shown, 'ui.syncChip');
    // Straight there, no discard question: nothing is lost by looking at sync.
    expect(shown.query('sync-status-screen')).not.toBeNull();
    expect(homeShown(shown)).toBe(false);

    await press(shown, 'sync-status-screen.back');
    expect(shown.query('sync-status-screen')).toBeNull();
    expect(homeShown(shown)).toBe(true);
    expect(reasonField(shown)?.props['value']).toBe(REASON);
  });

  test('hardware back from Sync Status does the same', async () => {
    const shown = await openStepWithTyping();

    await press(shown, 'ui.syncChip');
    expect(shown.query('sync-status-screen')).not.toBeNull();

    await settle();
    expect(__emitHardwareBack()).toBe(true);
    await settle();
    expect(shown.query('sync-status-screen')).toBeNull();
    expect(reasonField(shown)?.props['value']).toBe(REASON);
  });

  test('switching user from Sync Status first goes back to the half-typed intake and asks there', async () => {
    const { mounted } = await signedIn();
    await press(mounted, 'repair.board.newIntake');
    fire(mounted.get('repair.intake.customer.name.field'), 'onChangeText', 'Yohanis Wenda');
    await settle();

    await press(mounted, 'ui.syncChip');
    expect(mounted.query('sync-status-screen')).not.toBeNull();
    // The avatar on Sync Status, not the one on the hidden intake underneath.
    fire(mounted.all('ui.avatarButton').at(-1)!, 'onPress');
    await settle();

    expect(mounted.query('sync-status-screen')).toBeNull();
    expect(homeShown(mounted)).toBe(true);
    expect(mounted.query('repair.intake.discard')).not.toBeNull();
    expect(mounted.query('switcher-screen')).toBeNull();
    expect(mounted.get('repair.intake.customer.name.field').props['value']).toBe('Yohanis Wenda');
  });
});
