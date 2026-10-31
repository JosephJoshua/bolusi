/**
 * "Terakhir terhubung baru saja" ages while nothing else moves. A server that hangs sends nothing
 * back, so no sync event re-renders the shell; the clock-dependent reads must still be read again
 * (PC exploratory QA, F5). Drives the real `Root` over the live shell's database.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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

import { sql } from 'kysely';
import { act } from 'react';

import { textsIn, type RenderResult } from '../../../packages/ui/test/render.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  NOTES_PERMISSIONS,
  seedTwoUsers,
  settle,
  submitPin,
  TEST_PIN,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';

let fixture: Fixture | null = null;
let screen: RenderResult | null = null;

beforeEach(async () => {
  await closeClientDb();
});

afterEach(async () => {
  screen?.unmount();
  screen = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

test('Sync Status says how long ago it last connected, also when nothing new arrives', async () => {
  const target = await bootFixture();
  fixture = target;
  await enrolledDevice(target);
  await seedTwoUsers(target, 300, NOTES_PERMISSIONS);
  const syncedAt = Date.now();
  await sql`UPDATE sync_state SET last_successful_sync_at = ${syncedAt} WHERE id = 1`.execute(
    target.app.db.db,
  );
  // Only the interval is faked: the boot and the PIN keep their real timers.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const mounted = await mountRoot(target);
  screen = mounted;
  fireOn(mounted, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(mounted, TEST_PIN)).toBe(true);
  fireOn(mounted, 'ui.syncChip');
  await settle();
  expect(await waitUntil(() => mounted.query('sync-status-screen') !== null)).toBe(true);
  const label = () =>
    textsIn(mounted.get('sync-status-screen')).find((line) =>
      line.startsWith('Terakhir terhubung'),
    );
  expect(label()).toBe('Terakhir terhubung baru saja');

  vi.spyOn(Date, 'now').mockReturnValue(syncedAt + 5 * 60_000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  await settle();
  expect(label()).toBe('Terakhir terhubung 5 menit lalu');
});
