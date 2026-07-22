/**
 * THE COMPOSED-APP TEST for task 143 — is the User Switcher reachable in the RUNNING app once a
 * session is open?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * `SwitcherScreen` shipped built, styled, typed and covered, and `resolveZone` carried a `switcher`
 * zone with a `backTarget` rule — every one of those tests mounted the screen (or the zone value)
 * DIRECTLY. Not one asked: does anything a signed-in user can tap ever PRODUCE the switcher zone?
 * Nothing did. `resolveZone` returned `{kind:'shell'}` for every `session !== null && pinFor === null`
 * render, and the avatar's only handler was `setPinFor(null)` — a no-op in that state. So the header
 * avatar that design-system §8.1 says opens the User Switcher was a dead control, and PRD-011's
 * shared-device quick-switch did not exist on a real device while 100% of its tests stayed green.
 * CLAUDE.md §2.11's "sound tests, zero producers".
 *
 * ── SO THIS FILE MOUNTS `Root`, UNLOCKS A REAL SESSION, AND TAPS THE AVATAR ──────────────────────
 * A test that set `switching` (or rendered `SwitcherScreen`) itself would have been GREEN BEFORE THIS
 * TASK and would prove nothing about the defect: the zone and the screen always worked. This drives
 * the real composition root — boot the REAL data layer, reach the switcher, unlock with the REAL
 * argon2id `verifyPin`, land on the notes surface, and press the header control a user presses — then
 * asserts the switcher rendered its REAL CONTENT: the seeded roster's card and name, not a bare
 * `switcher-screen` testID over a blank tree (task 116's visual sweep found 35 such assertions).
 *
 * Everything below the seam is REAL for the reasons `live-shell-notes.test.tsx` states; the fakes here
 * are identical and for the same reason (they cannot exist in Node).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
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

import * as SecureStore from 'expo-secure-store';

import { textsIn, type RenderResult } from '../../../packages/ui/test/render.js';

import { __emitHardwareBack, __resetHardwareBack } from './doubles/react-native.js';
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
  type Fixture,
} from './live-shell-support.js';

/** The name `seedDirectory` writes into the roster — the REAL content the switcher must echo back. */
const SEEDED_USER_NAME = 'Andi Pratama';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-switcher-'));
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

/** Boot an enrolled+seeded device, unlock it with the real PIN, and land on the shell's home surface. */
async function unlockedShell(): Promise<RenderResult> {
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);

  const screen = await mountRoot(fixture);
  fireOn(screen, `switcher-user-${fixture.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  // The unlock genuinely happened — otherwise every assertion below would be reading the PIN pad.
  expect(opened).toBe(true);
  return screen;
}

/** Fire the REAL Android `BackHandler` and let effects settle (design-system §8.1: back == header back). */
async function pressHardwareBack(): Promise<boolean> {
  let consumed = false;
  await act(async () => {
    consumed = __emitHardwareBack();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  return consumed;
}

describe('the LIVE shell reaches the User Switcher from an open session (task 143)', () => {
  test('THE REPRODUCTION, STANDING: unlocked shell → header avatar → switcher renders its real roster', async () => {
    const screen = await unlockedShell();
    const userId = fixture?.userId ?? '';
    expect(userId).not.toBe('');

    // 1. THE DENOMINATOR (T-14). We are on the notes surface and the switcher is NOT rendered — so the
    //    assertions below cannot pass against a tree that was already showing it.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('switcher-screen')).toBeNull();

    // 2. THE AFFORDANCE. Not `setSwitching(true)` — the header avatar a user's thumb reaches. Before
    //    this task its handler was `setPinFor(null)`, a no-op with a session open, so this tap left the
    //    notes list exactly where it was: `switcher-screen ABSENT` (the task's own probe).
    fireOn(screen, 'ui.avatarButton');
    await settle();

    // 3. The switcher is on screen and the notes surface is gone — the gate genuinely moved.
    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();

    // 4. REAL CONTENT, not a testID over a blank screen. The roster card and the seeded NAME render —
    //    the directory the fixture applied through `applyBundle`, echoed back through the live session
    //    controller's `refresh()`. A `switcher-screen` testID alone would go green over an empty grid.
    expect(screen.query(`switcher-user-${userId}`)).not.toBeNull();
    expect(textsIn(screen.get(`switcher-user-name-${userId}`)).join(' ')).toContain(
      SEEDED_USER_NAME,
    );
  });

  test('the switch COMPLETES and lands on the shell — a stale `switching` never re-opens the roster', async () => {
    // The clear-on-opened half of the fix. Tapping a face → PIN pad → a correct PIN emits §6.3's
    // session ops and opens the incoming session; the gate must then show that user's SHELL, not the
    // roster again. Without clearing `switching` the completed switch would flip straight back to the
    // switcher over the new session.
    const screen = await unlockedShell();
    const userId = fixture?.userId ?? '';

    fireOn(screen, 'ui.avatarButton');
    await settle();
    expect(screen.query('switcher-screen')).not.toBeNull();

    fireOn(screen, `switcher-user-${userId}`);
    await settle();
    expect(screen.query('pin-pad')).not.toBeNull();

    const opened = await submitPin(screen, TEST_PIN);
    expect(opened).toBe(true);

    // Landed on the shell — the roster is gone and the notes surface is back.
    expect(screen.query('switcher-screen')).toBeNull();
    expect(screen.query('pin-pad')).toBeNull();
    expect(screen.query('notes.list.title')).not.toBeNull();
  });

  test('BACK from a switcher opened on the HOME avatar returns to the notes surface', async () => {
    const screen = await unlockedShell();

    fireOn(screen, 'ui.avatarButton');
    await settle();
    expect(screen.query('switcher-screen')).not.toBeNull();

    const consumed = await pressHardwareBack();

    // Consumed (never exits the app past a switch), and back on the surface it was opened from.
    expect(consumed).toBe(true);
    expect(screen.query('switcher-screen')).toBeNull();
    expect(screen.query('notes.list.title')).not.toBeNull();
  });

  test('BACK from a switcher opened on SETTINGS returns to SETTINGS, not unconditionally home (§8.1)', async () => {
    // THE RETURN-PATH HALF OF THE DEFECT. `backTarget` used to hardcode `route: 'home'`, so abandoning
    // a switch dumped the user on the notes list no matter where they opened it. The avatar on Settings
    // opens the switcher with `origin: 'settings'`, and back must land THERE.
    const screen = await unlockedShell();

    // Get onto the Settings surface first (task 124's header control), then open the switcher from ITS
    // avatar (`onOpenSwitcher`, which — pre-143 — navigated to `home`).
    fireOn(screen, 'shell-open-settings');
    await settle();
    expect(screen.query('settings-screen')).not.toBeNull();

    fireOn(screen, 'ui.avatarButton');
    await settle();
    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('settings-screen')).toBeNull();

    const consumed = await pressHardwareBack();

    // Back on SETTINGS — the origin — not on the notes home.
    expect(consumed).toBe(true);
    expect(screen.query('settings-screen')).not.toBeNull();
    expect(screen.query('switcher-screen')).toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
  });

  test('POSITIVE CONTROL: the avatar entry point is absent before the unlock — no switch pre-session', async () => {
    // The arm that makes the reproduction mean something. Pre-session the switcher is ALREADY the
    // surface (`session === null`), so "switcher renders" is trivially true and cannot prove the fix.
    // What the fix adds is a live-session PRODUCER — the avatar — and that node must NOT exist where a
    // switch is genuinely unavailable, or "the avatar opens the switcher" could pass on a control that
    // was always there. Pre-session there is no header avatar to tap.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture);

    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('ui.avatarButton')).toBeNull();
  });
});
