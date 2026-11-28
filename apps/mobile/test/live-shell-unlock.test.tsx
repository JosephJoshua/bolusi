// Owner Unlock, END TO END on the REAL shell (task 186b). The screen + the model are unit-tested
// (screens/pin/clear-lockout.model, staff-pin.model), but a mounted-screen test cannot see the WIRING this task adds:
// Settings staff PIN row → `setRoute('staffPins')` → `<StaffPinScreen>` fed a REAL target list loaded
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

import { t } from '@bolusi/i18n';
import * as SecureStore from 'expo-secure-store';

import { textsIn, type RenderResult } from '../../../packages/ui/test/render.js';

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
  fireOn(screen, 'ui.avatarButton');
  fireOn(screen, 'shell-open-settings');
  await settle();
  expect(screen.query('settings-screen')).not.toBeNull();
}

describe('Owner Unlock reaches the screen and clears a real lockout (task 186b)', () => {
  test('Settings → Staff PINs → pick the locked user → confirm → the counter is cleared', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedOwnerAndLockedTarget(fixture);
    const screen = await mountRoot(fixture);
    await signInAsOwner(screen);

    // POSITIVE CONTROL: the seed genuinely locked the target — otherwise the clear below would be a
    // no-op and "cleared" would prove nothing (T-14b).
    expect(await pinFailuresFor(fixture, SECOND_USER_ID)).toBe(PIN_HARD_LOCK_THRESHOLD);

    await openSettings(screen);
    // The owner holds `auth.pin_unlock`, so the staff PIN row is offered (the gate, end-to-end).
    expect(screen.query('settings-staff-pins')).not.toBeNull();
    // ...and, deciding conflicts, the notifications about data that needs that decision.
    expect(screen.query('settings-notifications-conflict')).not.toBeNull();

    fireOn(screen, 'settings-staff-pins');
    await settle();
    expect(screen.query('staff-pin-screen')).not.toBeNull();

    // The target list loads asynchronously on entry; wait for the locked user's row to appear. If the
    // App render branch were missing, or the list never loaded, this row never shows and the test reds.
    const targetRow = `staff-pin-target-${SECOND_USER_ID}`;
    await waitUntil(() => screen.query(targetRow) !== null);
    expect(screen.query(targetRow)).not.toBeNull();

    fireOn(screen, targetRow); // pick → their page, where unlocking is the primary action
    await settle();
    fireOn(screen, 'staff-pin-unlock'); // → confirm sheet
    await settle();
    expect(screen.query('staff-pin-unlock-confirm')).not.toBeNull();

    fireOn(screen, 'staff-pin-unlock-confirm.confirm'); // confirm → session.clearLockout runs the flow
    await waitUntil(
      () =>
        screen.query('staff-pin-unlock-done') !== null ||
        screen.query('staff-pin-unlock-failed') !== null,
    );
    // The whole path succeeded: the done panel shows (not the failure panel). A broken link anywhere —
    // the row, the route, App.onClearLockout, session.clearLockout — never reaches done.
    expect(screen.query('staff-pin-unlock-done')).not.toBeNull();

    // The REAL witness: the target's attempt counter is now cleared (§6.5). Point `onClearLockout` at a
    // no-op and this reds while the done panel still shows — the counter is what the flow actually moved.
    expect(await pinFailuresFor(fixture, SECOND_USER_ID)).toBe(0);
  });

  test('CONTROL: a non-owner sees no staff PIN row — the canUnlock gate holds over the whole stack', async () => {
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
    expect(screen.query('settings-staff-pins')).toBeNull();
    // Nor the notifications about data only an owner can decide; the device ones stay.
    expect(screen.query('settings-notifications-conflict')).toBeNull();
    expect(screen.query('settings-notifications-device')).not.toBeNull();
  });
});

describe('a wrong PIN is answered on the pad, every time (Android QA on PR #44)', () => {
  test('two wrong PINs in a row each clear the dots, say "PIN salah" and reach the real verify', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);
    const screen = await mountRoot(fixture);
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();

    const typeWrong = async (expectedFailures: number): Promise<void> => {
      for (const digit of '000000') fireOn(screen, `pin-pad.key.${digit}`);
      await waitUntil(
        async () =>
          fixture !== null && (await pinFailuresFor(fixture, fixture.userId)) === expectedFailures,
      );
      await settle();
      expect(await pinFailuresFor(fixture!, fixture!.userId)).toBe(expectedFailures);
      expect(textsIn(screen.get('pin-pad.message')).join(' ')).toContain(t('auth.pin.wrong'));
      // The dots are empty again, ready for the next try.
      expect(screen.get('pin-pad.entry').props['accessibilityValue']).toMatchObject({ now: 0 });
    };
    await typeWrong(1);
    // Before the fix the pad kept the six digits from the first try, so these keys did nothing and
    // the second verify never ran: the counter would stay at 1.
    await typeWrong(2);
  });
});
