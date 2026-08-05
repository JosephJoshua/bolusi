// Change PIN, END TO END on the REAL shell (task 186a). The screen + the model are unit-tested
// (screens/pin/*), but a mounted-screen test cannot see the WIRING this task adds: Settings row →
// `setRoute('changePin')` → `<ChangePinScreen>` → `App.onChangePin` → `session.changePin` → core's
// `auth.changePin` over the real directory + a real argon2id verifier. This file drives that whole
// path on the real `Root`, with a real DB and a real PIN verifier, so a broken link anywhere reds.
//
// The verifier is a REAL argon2id derivation of `TEST_PIN` (live-shell-support seedDirectory), so the
// current-PIN check genuinely has to match — a wrong current PIN genuinely fails and burns an attempt.
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
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  waitForFailedAttempt,
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
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-changepin-'));
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

/** Boot an enrolled+seeded device, sign in with the real PIN, and land on the shell home. */
async function unlockedShell(): Promise<RenderResult> {
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);
  const screen = await mountRoot(fixture);
  fireOn(screen, `switcher-user-${fixture.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
  return screen;
}

/** Navigate an unlocked shell to the Change-PIN screen via the Settings row. */
async function openChangePin(screen: RenderResult): Promise<void> {
  fireOn(screen, 'shell-open-settings');
  await settle();
  expect(screen.query('settings-screen')).not.toBeNull();
  fireOn(screen, 'settings-change-pin');
  await settle();
  expect(screen.query('change-pin-screen')).not.toBeNull();
}

/** Press the six digits of `pin` on the Change-PIN pad (it fires `onComplete` on the 6th). */
function enterOnPad(screen: RenderResult, pin: string): void {
  for (const digit of pin) fireOn(screen, `change-pin-pad.key.${digit}`);
}

describe('Change PIN reaches the screen and runs the real flow (task 186a)', () => {
  test('Settings → Change PIN → current verifies + new set → the done panel shows', async () => {
    const screen = await unlockedShell();
    await openChangePin(screen);

    enterOnPad(screen, TEST_PIN); // current
    await settle();
    enterOnPad(screen, NEW_PIN); // new
    await settle();
    enterOnPad(screen, NEW_PIN); // repeat → submit → session.changePin (real argon2id)

    // The whole path succeeded: the current PIN verified and the new verifier was written. If any link
    // were unwired (the row, the route, App.onChangePin, session.changePin) this never appears. Wait on
    // the SETTLE (done, or the pad's message returning after a failure) — the pad's message is null only
    // while `submitting`, so this does not return mid-flight.
    await waitUntil(
      () =>
        screen.query('change-pin-done') !== null || screen.query('change-pin-pad.message') !== null,
    );
    expect(screen.query('change-pin-done')).not.toBeNull();
  });

  test('a WRONG current PIN is refused — the flow verifies for real, so it never reaches done', async () => {
    const screen = await unlockedShell();
    await openChangePin(screen);

    enterOnPad(screen, '000000'); // wrong current
    await settle();
    enterOnPad(screen, NEW_PIN);
    await settle();
    enterOnPad(screen, NEW_PIN); // repeat → submit → session.changePin rejects NOT_AUTHENTICATED

    // The counter MOVING is the witness that `verifyPin` actually ran and refused — not that the test
    // got bored (the same rigor the login wrong-PIN control uses).
    if (fixture === null) throw new Error('fixture');
    const failures = await waitForFailedAttempt(fixture);
    expect(failures).toBeGreaterThan(0);
    await settle();
    expect(screen.query('change-pin-done')).toBeNull();
    expect(screen.query('change-pin-pad')).not.toBeNull();
  });
});
