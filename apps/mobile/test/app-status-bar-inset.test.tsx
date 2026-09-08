// The shell's edge-to-edge TOP inset must reflect the status-bar height AT RENDER, not a value frozen
// when the App module first evaluated. On the emulator lane a cold app launch left
// `StatusBar.currentHeight` unpopulated at bundle-eval; the old module-scope `const STATUS_BAR_INSET`
// froze 0, the shell got `paddingTop: 0`, and the header drew UNDER the status-bar window (z-above the
// app) — its language chip (`shell-open-settings`) was occluded, absent from the accessibility
// hierarchy, and un-tappable. Flow 06 (`06-i18n-toggle`) flaked on exactly this while the same run's
// flow 03 — a warmer process whose read landed after the constant was ready — inset correctly and
// passed. These tests render the REAL `App` and read the shell's declared `paddingTop`.
//
// Test 1 falsifies the frozen-at-import behaviour: it changes `currentHeight` AFTER import and asserts
// the render reflects the new value. Test 2 guards the fallback: an unavailable (0 / null) height must
// still inset by a non-zero amount, never 0 — under-insetting occludes a control.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The Expo native modules App's module graph touches — doubled so their `__DEV__`-dependent real code
// never loads (same set the live-shell tests mock).
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

import { StatusBar as RNStatusBar } from 'react-native';

import App, { type AppProps } from '../App.js';
import { render, type RenderResult } from '../../../packages/ui/test/render.js';
import {
  DEMO_DEVICE_INFO,
  DEMO_USERS,
  HARNESS_NOW,
  demoSyncInput,
  fakeEnrollmentController,
} from '../src/web/seed.js';

const noop = (): void => undefined;
const OWNER = DEMO_USERS[0]!;

/** A session-open owner shell — the zone that renders the notes surface header with the language chip. */
function props(): AppProps {
  return {
    device: 'active',
    users: DEMO_USERS,
    usersError: null,
    pinRow: () => null,
    now: HARNESS_NOW,
    session: { userId: OWNER.id },
    locked: false,
    sync: demoSyncInput(),
    onSyncNow: noop,
    onRetryMedia: noop,
    onRetryUsers: noop,
    onSubmitPin: () => undefined,
    onChangePin: () => Promise.resolve(),
    canUnlock: true,
    listPinTargets: () => Promise.resolve([]),
    onClearLockout: () => Promise.resolve(),
    canReset: true,
    onResetPin: () => Promise.resolve(),
    onSelectLocale: noop,
    locale: 'id',
    deviceInfo: DEMO_DEVICE_INFO,
    enrollment: fakeEnrollmentController(),
  };
}

// `currentHeight` is a shared mutable member of the RN double; save and restore so per-test mutations
// never leak into another suite.
const ORIGINAL_HEIGHT = RNStatusBar.currentHeight;
let screen: RenderResult | null = null;

beforeEach(() => {
  (RNStatusBar as { currentHeight: number | null | undefined }).currentHeight = ORIGINAL_HEIGHT;
});
afterEach(() => {
  screen?.unmount();
  screen = null;
  (RNStatusBar as { currentHeight: number | null | undefined }).currentHeight = ORIGINAL_HEIGHT;
});

describe('shell status-bar inset (edge-to-edge top inset)', () => {
  test('reflects the status-bar height read AT RENDER, not one frozen at module-eval', () => {
    // A value the module-eval read could not have seen (the double is 24 at import). A render-time read
    // returns it; a frozen module-scope const returns the stale import-time 24.
    (RNStatusBar as { currentHeight: number | null }).currentHeight = 37;
    act(() => {
      screen = render(<App {...props()} />);
    });
    expect(screen!.styleOf('bolusi-app-shell').paddingTop).toBe(37);
  });

  test('falls back to a non-zero inset when the status-bar height is unavailable (0)', () => {
    (RNStatusBar as { currentHeight: number | null }).currentHeight = 0;
    act(() => {
      screen = render(<App {...props()} />);
    });
    // Never 0: a 0 top inset draws the header under the status bar and occludes the language chip.
    expect(screen!.styleOf('bolusi-app-shell').paddingTop).toBeGreaterThan(0);
  });

  test('falls back to a non-zero inset when the status-bar height is unavailable (null)', () => {
    (RNStatusBar as { currentHeight: number | null }).currentHeight = null;
    act(() => {
      screen = render(<App {...props()} />);
    });
    expect(screen!.styleOf('bolusi-app-shell').paddingTop).toBeGreaterThan(0);
  });
});
