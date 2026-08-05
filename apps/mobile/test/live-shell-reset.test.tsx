// Owner Reset, END TO END on the REAL shell (task 186b-2), with the SECURITY property this task exists
// to guarantee: an owner resets ANOTHER user's PIN, and the verifier POST that carries it to the server
// is sent AS THE OWNER (`X-Acting-User`), never as the target. Sending the target would bypass the
// server's `auth.user_reset_pin` check (§6.6). The core `PendingVerifier` now carries the acting owner;
// this drives Settings → Reset → pick target → new PIN → confirm on the real `Root`, then fires the
// online drain and asserts the POST's acting user IS the owner.
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
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import * as SecureStore from 'expo-secure-store';

import type { RenderResult } from '../../../packages/ui/test/render.js';

import { __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  SECOND_USER_ID,
  seedDirectory,
  seedOwnerAndLockedTarget,
  settle,
  submitPin,
  TEST_PIN,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';

const NEW_PIN = '731864';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-reset-'));
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

async function signInAsOwner(screen: RenderResult): Promise<void> {
  fireOn(screen, `switcher-user-${fixture?.userId ?? ''}`);
  await settle();
  expect(await submitPin(screen, TEST_PIN)).toBe(true);
}

async function openSettings(screen: RenderResult): Promise<void> {
  fireOn(screen, 'shell-open-settings');
  await settle();
  expect(screen.query('settings-screen')).not.toBeNull();
}

/** Press the six digits of `pin` on the Reset pad (fires `onComplete` on the 6th). */
function enterOnResetPad(screen: RenderResult, pin: string): void {
  for (const digit of pin) fireOn(screen, `reset-pin-pad.key.${digit}`);
}

describe('Owner Reset reaches the screen and POSTs the verifier as the OWNER (task 186b-2)', () => {
  test('Settings → Reset → pick target → new PIN → the verifier drains with X-Acting-User = the owner', async () => {
    const uploads: Array<{ userId: string; actingUserId: string }> = [];
    let onBundleRefreshed: (() => void | Promise<void>) | undefined;

    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedOwnerAndLockedTarget(fixture);
    const screen = await mountRoot(fixture, {
      uploadPinVerifier: {
        // The 4th arg is the ACTING user (§6.6) — the whole point of this test.
        upload: (userId, _verifierRef, _verifier, actingUserId) => {
          uploads.push({ userId, actingUserId });
          return Promise.resolve({ userId, applied: true });
        },
      },
      createSync: (_booted, refresh) => {
        onBundleRefreshed = refresh;
        return null;
      },
    });
    await signInAsOwner(screen);

    // Settings → Reset a PIN (the owner holds `auth.user_reset_pin`, so the row is offered).
    await openSettings(screen);
    expect(screen.query('settings-reset-pin')).not.toBeNull();
    fireOn(screen, 'settings-reset-pin');
    await settle();
    expect(screen.query('reset-pin-screen')).not.toBeNull();

    // Pick the target (loaded on entry), proceed past the hand-over, then enter the new PIN twice.
    const targetRow = `reset-pin-target-${SECOND_USER_ID}`;
    await waitUntil(() => screen.query(targetRow) !== null);
    fireOn(screen, targetRow);
    await settle();
    fireOn(screen, 'reset-pin-proceed'); // hand-over → the target types their new PIN
    await settle();
    enterOnResetPad(screen, NEW_PIN); // first entry
    await settle();
    enterOnResetPad(screen, NEW_PIN); // repeat → match → submitting → session.resetPin
    await waitUntil(
      () => screen.query('reset-pin-done') !== null || screen.query('reset-pin-failed') !== null,
    );
    // The reset applied locally (a real verifier was written + queued). A broken link anywhere reds here.
    expect(screen.query('reset-pin-done')).not.toBeNull();

    // Nothing POSTs until the device is next online.
    expect(uploads).toHaveLength(0);
    expect(onBundleRefreshed).toBeDefined();
    await onBundleRefreshed?.();

    // THE SECURITY WITNESS: the verifier POSTed to the TARGET's path, acting AS THE OWNER — never the
    // target. On the pre-fix core (PendingVerifier carrying only the target) the acting user would be
    // the target and this reds.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.userId).toBe(SECOND_USER_ID); // the reset target (the POST path)
    expect(uploads[0]?.actingUserId).toBe(fixture.userId); // the RESETTING OWNER (X-Acting-User)
  });

  test('CONTROL: a non-owner sees no Reset row — the canReset gate holds over the whole stack', async () => {
    // `seedDirectory` grants no `auth.user_reset_pin`, so `session.canReset` is false, App omits the
    // callback, SettingsScreen omits the row. Make the row unconditional and this reds.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);
    const screen = await mountRoot(fixture);
    await signInAsOwner(screen); // (the sole seeded user — a non-owner here)

    await openSettings(screen);
    expect(screen.query('settings-change-pin')).not.toBeNull(); // Security section rendered
    expect(screen.query('settings-reset-pin')).toBeNull(); // but the owner row is gated out
  });
});
