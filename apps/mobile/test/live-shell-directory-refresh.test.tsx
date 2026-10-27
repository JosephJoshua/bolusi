// A colleague added on another device (or straight through the server) reaches THIS phone's switcher
// as soon as a bundle refresh brings them, with no restart. Found on the Android QA run: the bundle
// landed the new user in `users_directory`, but the switcher kept the roster it read at boot.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The Expo native modules the Root chain touches — doubled so their `__DEV__`-dependent real code
// never loads (same set every live-shell test mocks).
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

import * as SecureStore from 'expo-secure-store';

import { __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  mountRoot,
  SECOND_USER_ID,
  seedDirectory,
  seedTwoUsers,
  settle,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-directory-'));
  secureStore = new Map<string, string>();
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => secureStore.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    secureStore.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    secureStore.delete(key);
  });
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
  __resetHardwareBack();
  rmSync(tempDir, { recursive: true, force: true });
});

test('a colleague brought by a bundle refresh shows on the switcher without a restart', async () => {
  let onBundleRefreshed: (() => void | Promise<void>) | undefined;
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);
  const screen = await mountRoot(fixture, {
    createSync: (_booted, refresh) => {
      onBundleRefreshed = refresh;
      return null;
    },
  });
  await waitUntil(() => screen.query(`switcher-user-${fixture?.userId ?? ''}`) !== null);
  expect(screen.query(`switcher-user-${SECOND_USER_ID}`)).toBeNull();

  // The next bundle carries the new colleague: `applyBundle` writes them, then the refresh hook fires.
  await seedTwoUsers(fixture);
  expect(onBundleRefreshed).toBeDefined();
  await onBundleRefreshed?.();
  await settle();

  expect(screen.query(`switcher-user-${SECOND_USER_ID}`)).not.toBeNull();
});
