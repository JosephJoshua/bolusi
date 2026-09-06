// The background location watcher must NOT gate the app shell (task 199), END TO END on the REAL
// `Root` boot path. `startLocationWatcher()` is a DIRECT IMPORT in Root.tsx (not an injectable prop),
// so a unit test of `location.ts`, or of `Root` with an injected `boot`, cannot see this wire — only
// mounting the real `Root` with a real-shaped wedged expo-location does ([[bolusi-falsify-at-the-boundary]]).
//
// The defect: `Root.tsx` awaited `startLocationWatcher()` on the critical path BEFORE `boot()`, so a
// location provider that never settles hangs boot forever and the shell never mounts. On the AOSP CI
// emulator (no Google Play Services) balanced-accuracy `watchPositionAsync` resolves through the Google
// fused provider, which returns SERVICE_INVALID and never resolves — a permanent white screen with no
// crash and no retry (RN release swallows it). The same class reaches any real de-Googled / location-off
// device. This test reproduces that shape: permission GRANTED, then `watchPositionAsync` never resolves.
//
// Every other live-shell test mocks `requestForegroundPermissionsAsync` to `{ status: 'denied' }`, which
// hits `startLocationWatcher`'s fast `if (!granted) return` and settles instantly — so none of them
// exercises the granted-then-hang branch, and the boot-gating `await` shipped unseen.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

// THE RELEVANT DOUBLE: permission GRANTED (unlike every other live-shell test), then a `watchPositionAsync`
// that NEVER resolves — the on-device fused-provider SERVICE_INVALID shape. `startLocationWatcher()` awaits
// this, so with the boot-gating `await` in place the shell never mounts.
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted', granted: true })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted', granted: true })),
  watchPositionAsync: vi.fn(() => new Promise<never>(() => {})),
}));

import * as SecureStore from 'expo-secure-store';

import { __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  mountRoot,
  seedDirectory,
  type Fixture,
} from './live-shell-support.js';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-location-'));
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

describe('location watcher does not gate the app shell (task 199)', () => {
  test('the shell renders even when the location watcher never resolves', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    // Mounts the REAL Root; its boot IIFE calls the direct-import `startLocationWatcher()` mocked above
    // to hang forever. `mountRoot` renders + settles microtasks — it does NOT wait on boot — so if boot
    // is gated on the watcher, Root stays `null` and no `bolusi-app-shell` mounts.
    const screen = await mountRoot(fixture);

    // The exact assertion the on-device `01-launch-enrollment` Maestro flow makes, at the render boundary:
    // the app shell must be present regardless of the location provider's state.
    expect(screen.query('bolusi-app-shell')).not.toBeNull();
  });
});
