// Owner Unlock, END TO END on the REAL shell (task 186b). The screen + the model are unit-tested
// (screens/pin/clear-lockout.*), but a mounted-screen test cannot see the WIRING this task adds:
// Settings owner row → `setRoute('unlockPin')` → `<ClearLockoutScreen>` fed a REAL target list loaded
// from the directory + `pin_attempt_state` → `App.onClearLockout` → `session.clearLockout` → core's
// `clearPinLockoutFlow` over the real attempt row. This file drives that whole path on the real `Root`,
// with a real DB, so a broken link anywhere reds.
//
// The target user is seeded ALREADY LOCKED (a real `pin_attempt_state` row at the hard-lock threshold),
// so the flow's locked precondition is genuinely satisfied and the cleared counter is a real witness —
// not a no-op clear that would emit nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PIN_HARD_LOCK_THRESHOLD } from '@bolusi/core';
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
  pinFailuresFor,
  SECOND_USER_ID,
  seedDirectory,
  seedOwnerAndLockedTarget,
  settle,
  submitPin,
  TEST_PIN,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-unlock-'));
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

/** Sign in as `fixture.userId` (the owner) with the real PIN and land on the shell home. */
async function signInAsOwner(screen: RenderResult): Promise<void> {
  fireOn(screen, `switcher-user-${fixture?.userId ?? ''}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
}

/** Open Settings from the shell home. */
async function openSettings(screen: RenderResult): Promise<void> {
  fireOn(screen, 'shell-open-settings');
  await settle();
  expect(screen.query('settings-screen')).not.toBeNull();
}

describe('Owner Unlock reaches the screen and clears a real lockout (task 186b)', () => {
  test('Settings → Unlock a PIN → pick the locked user → confirm → the counter is cleared', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedOwnerAndLockedTarget(fixture);
    const screen = await mountRoot(fixture);
    await signInAsOwner(screen);

    // POSITIVE CONTROL: the seed genuinely locked the target — otherwise the clear below would be a
    // no-op and "cleared" would prove nothing (T-14b).
    expect(await pinFailuresFor(fixture, SECOND_USER_ID)).toBe(PIN_HARD_LOCK_THRESHOLD);

    await openSettings(screen);
    // The owner holds `auth.pin_unlock`, so the row is offered (the canUnlock gate, end-to-end).
    expect(screen.query('settings-unlock-pin')).not.toBeNull();

    fireOn(screen, 'settings-unlock-pin');
    await settle();
    expect(screen.query('clear-lockout-screen')).not.toBeNull();

    // The target list loads asynchronously on entry; wait for the locked user's row to appear. If the
    // App render branch were missing, or the list never loaded, this row never shows and the test reds.
    const targetRow = `clear-lockout-target-${SECOND_USER_ID}`;
    await waitUntil(() => screen.query(targetRow) !== null);
    expect(screen.query(targetRow)).not.toBeNull();

    fireOn(screen, targetRow); // pick → confirm sheet
    await settle();
    expect(screen.query('clear-lockout-confirm')).not.toBeNull();

    fireOn(screen, 'clear-lockout-confirm.confirm'); // confirm → session.clearLockout runs the flow
    await waitUntil(
      () =>
        screen.query('clear-lockout-done') !== null ||
        screen.query('clear-lockout-failed') !== null,
    );
    // The whole path succeeded: the done panel shows (not the failure panel). A broken link anywhere —
    // the row, the route, App.onClearLockout, session.clearLockout — never reaches done.
    expect(screen.query('clear-lockout-done')).not.toBeNull();

    // The REAL witness: the target's attempt counter is now cleared (§6.5). Point `onClearLockout` at a
    // no-op and this reds while the done panel still shows — the counter is what the flow actually moved.
    expect(await pinFailuresFor(fixture, SECOND_USER_ID)).toBe(0);
  });

  test('CONTROL: a non-owner sees no Unlock row — the canUnlock gate holds over the whole stack', async () => {
    // `seedDirectory` grants notes + `auth.pin_change` but NOT `auth.pin_unlock`, so the signed-in user
    // is not an owner. The Settings Unlock row must be absent: `session.canUnlock` is false, App omits
    // the callback, SettingsScreen omits the row. Make the row unconditional and this reds.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);
    const screen = await mountRoot(fixture);
    await signInAsOwner(screen); // (the sole seeded user — a non-owner here)

    await openSettings(screen);
    // The Change-PIN row (every role) is still present — proof the Security section rendered and it is
    // specifically the owner row that is gated out, not the whole section missing.
    expect(screen.query('settings-change-pin')).not.toBeNull();
    expect(screen.query('settings-unlock-pin')).toBeNull();
  });
});
