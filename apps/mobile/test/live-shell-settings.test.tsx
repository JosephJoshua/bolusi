/**
 * THE COMPOSED-APP TEST for task 124 — is the Settings screen reachable in the RUNNING app?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * `SettingsScreen` shipped built, styled, typed and covered: its own `SettingsScreen.test.tsx` and
 * `model.test.ts` were green, `App.tsx` carried a live `route === 'settings'` render arm, `zone.ts`
 * carried the route in `ShellRoute` and a `backTarget` rule for it, and the web gallery screenshotted
 * it. Every one of those mounted the screen (or the route value) DIRECTLY. Not one asked the question
 * this file asks: does anything a user can tap ever call `setRoute('settings')`? Nothing did —
 * `grep -rn "setRoute('settings')" apps/mobile` returned no production call site — so the language
 * toggle (07-i18n §1.2: the ONLY UI for the device locale), the notification deep-links (api/04-push
 * §5) and the device-identity readout were unreachable on a shipping device while 100% of their tests
 * stayed green. CLAUDE.md §2.11's "sound tests, zero callers".
 *
 * ── SO THIS FILE MOUNTS `Root` AND TAPS THE AFFORDANCE ──────────────────────────────────────────
 * That distinction is the whole point, and it is why nothing here calls `setRoute` or renders
 * `SettingsScreen`. A test that set the route itself would have been GREEN BEFORE THIS TASK and would
 * have proven nothing about the defect: the arm always worked. This drives the real composition root
 * end to end — boot the REAL data layer, reach the switcher, unlock with the REAL argon2id `verifyPin`,
 * land on the notes surface, and press the header control a user presses — then asserts Settings
 * rendered its REAL CONTENT: the device id the fixture seeded, echoed back through the screen. A
 * `settings-screen` testID alone would go green over a blank screen (task 116's visual sweep found 35
 * such assertions), so the identity readout — the field that exists "so the shop can read its own
 * device's identity to an owner over the phone" — is what is asserted.
 *
 * Everything below the seam is REAL for the same reasons `live-shell-notes.test.tsx` states; the
 * fakes here are identical and for the same reason (they cannot exist in Node).
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

import { getI18nInstance } from '@bolusi/i18n';

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

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-settings-'));
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

describe('the LIVE shell reaches Settings from the home surface (task 124)', () => {
  test('THE REPRODUCTION, STANDING: unlocked shell → header Settings control → Settings renders its real content', async () => {
    const screen = await unlockedShell();

    // 1. THE DENOMINATOR (T-14). We are on the notes surface and Settings is NOT rendered — so the
    //    assertions below cannot pass against a tree that was already showing it.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('settings-screen')).toBeNull();

    // 2. THE AFFORDANCE. Not `setRoute('settings')` — the header control a user's thumb reaches.
    //    Before this task no such node existed anywhere in shipping source and `screen.get` threw.
    fireOn(screen, 'shell-open-settings');
    await settle();

    // 3. Settings is on screen and the notes surface is gone — the shell route genuinely moved.
    expect(screen.query('settings-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();

    // 4. REAL CONTENT, not a testID over a blank screen. The identity readout echoes the deviceId
    //    this fixture seeded into `meta_kv` and `Root` read back at boot — a value no stub produces.
    const deviceId = fixture?.deviceId ?? '';
    expect(deviceId).not.toBe('');
    expect(textsIn(screen.get('settings-device-id')).join('|')).toContain(deviceId);

    // 5. The language rows — the reason this screen must be reachable at all (07-i18n §1.2). Both
    //    options render, and the ACTIVE one is marked, which is what tells a user stranded in the
    //    wrong locale which row is currently theirs.
    expect(screen.query('settings-locale-id')).not.toBeNull();
    expect(screen.query('settings-locale-en')).not.toBeNull();
    expect(screen.query('settings-locale-active-id')).not.toBeNull();
  });

  test('THE REPRODUCTION (task 211): tapping the English row renders the shell IN English', async () => {
    // WHY THIS IS A SEPARATE TEST FROM THE ONE ABOVE, WHICH ALREADY TOUCHES THE LANGUAGE ROWS.
    // That test asserts the rows EXIST and that the active one is MARKED. Both stayed green through
    // the entire defect, because both are driven by `Root`'s React `locale` state — which the toggle
    // did update. What it never updated was the i18next singleton that `t()` actually reads, so the
    // checkmark moved and every string on screen stayed Indonesian. Maestro flow 06 asserted the same
    // marker testID and was green for the same wrong reason. The observable a user cares about is the
    // one neither checked: did the WORDS change.
    //
    // NO COPY LITERALS (testing-guide: tests never assert UI copy). `getFixedT(locale)` reads a
    // catalog directly, independent of the ACTIVE language, so the expectations come from the same
    // source the screen renders from — and the test keeps working when the copy is reworded.
    const screen = await unlockedShell();
    fireOn(screen, 'shell-open-settings');
    await settle();

    const i18n = getI18nInstance();
    const inIndonesian = i18n.getFixedT('id')('core.settings.language');
    const inEnglish = i18n.getFixedT('en')('core.settings.language');
    // The fixture is meaningful: if this key happened to be identical in both catalogs the assertions
    // below could not distinguish a working toggle from a broken one.
    expect(inEnglish).not.toBe(inIndonesian);

    // 1. THE DENOMINATOR (T-14). The shell is rendering Indonesian BEFORE the tap, so a pass below
    //    cannot come from a tree that was already in English.
    expect(textsIn(screen.get('settings-section-language')).join('')).toBe(inIndonesian);
    expect(screen.query('settings-rendered-locale-id')).not.toBeNull();

    // 2. The affordance a user's thumb reaches — not `setLocale`, not a prop.
    fireOn(screen, 'settings-locale-en');
    await settle();

    // 3. The marker moves. This is the ENTIRE old assertion surface; it passes either way.
    expect(screen.query('settings-locale-active-en')).not.toBeNull();

    // 4. THE DEFECT. The active locale and the rendered string must follow the tap. On an
    //    Indonesian-first product these rows are documented (07-i18n §1.2) as the only way out of a
    //    language you cannot read, so "applies on next launch" is not a working toggle.
    expect(i18n.language).toBe('en');
    expect(textsIn(screen.get('settings-section-language')).join('')).toBe(inEnglish);

    // 5. THE ON-DEVICE WITNESS. `.maestro/06-i18n-toggle.yaml` asserts this testID instead of a
    //    rendered string (T-4 forbids asserting copy), so it is the only thing standing between that
    //    flow and the false-green it just spent a release in. Covered here so a change that leaves it
    //    stale fails in CI rather than silently disarming the emulator lane.
    expect(screen.query('settings-rendered-locale-en')).not.toBeNull();
    expect(screen.query('settings-rendered-locale-id')).toBeNull();
  });

  test('Android hardware back returns from Settings to the notes surface (design-system §8.1, zone.backTarget)', async () => {
    // §8.1: hardware back IS the header back. `backTarget({kind:'shell', route:'settings'})` yields
    // `home`, and this drives the REAL `BackHandler` listener `useHardwareBack` registered — so a
    // user who opens Settings can always get out the way the platform expects.
    const screen = await unlockedShell();
    fireOn(screen, 'shell-open-settings');
    await settle();
    expect(screen.query('settings-screen')).not.toBeNull();

    let consumed = false;
    await act(async () => {
      consumed = __emitHardwareBack();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // Consumed, NOT passed through to Android — Settings is one level deep, never the app's exit.
    expect(consumed).toBe(true);
    expect(screen.query('settings-screen')).toBeNull();
    expect(screen.query('notes.list.title')).not.toBeNull();
  });

  test('POSITIVE CONTROL: the entry point is absent before the unlock — Settings is not reachable pre-session', async () => {
    // The arm that makes the two above mean something. If the control rendered on every surface, the
    // reproduction would pass on a shell that had leaked Settings onto the lock/switcher path, where
    // `resolveZone` cannot render it anyway (`currentUser` is null pre-session) — a control that
    // navigates nowhere. It must exist only where the route it produces can actually be served.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture);

    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('shell-open-settings')).toBeNull();
  });
});
