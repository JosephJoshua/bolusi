// First PIN, END TO END on the REAL shell (api/02-auth §6.6). The owner who enrolled this phone makes
// their own first PIN: switcher → setup → stored verifier → signed in, on the real `Root` over a real
// DB, so a broken link anywhere (the roster flag, App's branch, `session.setFirstPin`, core's flow)
// reds. Anyone else without a PIN is sent to ask an owner: a phone that is behind could otherwise
// let a coworker make a PIN for someone who already has one, and sign in as them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIRST_PIN_USER_META_KEY, readVerifier, writeMeta } from '@bolusi/core';
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
  seedUserWithoutPin,
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
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-first-pin-'));
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

const NEW_PIN = '730215';

function enterOnSetupPad(screen: RenderResult, pin: string): void {
  for (const digit of pin) fireOn(screen, `pin-setup-pad.key.${digit}`);
}

describe('the owner who enrolled this phone makes their own first PIN', () => {
  test('switcher → first PIN twice → a real verifier is stored and the shell opens', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedUserWithoutPin(fixture);
    // As `runEnrollment` records: this user enrolled the phone with their password.
    await writeMeta(fixture.app.db.db, FIRST_PIN_USER_META_KEY, SECOND_USER_ID);
    const screen = await mountRoot(fixture);

    // The roster says so before the tap, and the tap goes to setup, not to the sign-in pad.
    expect(screen.query(`switcher-user-nopin-${SECOND_USER_ID}`)).not.toBeNull();
    fireOn(screen, `switcher-user-${SECOND_USER_ID}`);
    await settle();
    expect(screen.query('pin-setup-screen')).not.toBeNull();
    expect(screen.query('pin-pad')).toBeNull();
    expect(await readVerifier(fixture.app.db.db, SECOND_USER_ID)).toBeNull();

    enterOnSetupPad(screen, NEW_PIN);
    await settle();
    enterOnSetupPad(screen, NEW_PIN);
    const opened = await waitUntil(() => screen.query('pin-setup-screen') === null);
    await settle();

    expect(opened).toBe(true);
    // The real witness: a verifier now exists for THIS user, and the shell is open (its avatar is up).
    expect(await readVerifier(fixture.app.db.db, SECOND_USER_ID)).not.toBeNull();
    expect(screen.query('ui.avatarButton')).not.toBeNull();
  });
});

describe('anyone else without a PIN is sent to ask an owner', () => {
  test('switcher → no pad, no setup, and nothing is written', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedUserWithoutPin(fixture);
    const screen = await mountRoot(fixture);

    fireOn(screen, `switcher-user-${SECOND_USER_ID}`);
    await settle();
    expect(screen.query('pin-needs-first')).not.toBeNull();
    expect(screen.query('pin-setup-screen')).toBeNull();
    expect(screen.query('pin-pad')).toBeNull();
    expect(await readVerifier(fixture.app.db.db, SECOND_USER_ID)).toBeNull();
  });
});
