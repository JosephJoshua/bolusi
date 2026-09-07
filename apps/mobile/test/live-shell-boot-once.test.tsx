/**
 * THE RENDER-BOUNDARY GUARD for the task-201 emulator blank screen (flows 01-launch-enrollment and
 * 02-pin-entry).
 *
 * ── WHAT WAS BROKEN, AND WHY EVERY EXISTING TEST STAYED GREEN ────────────────────────────────────
 * On the emulator the app boots to an EMPTY view: `Running "main"` fires, no crash, and the screen
 * hierarchy is bare `android:id/content`. The device logcat shows the `[boot]` session-open chain
 * running over and over. Root cause: `index.ts` renders the shell by CALLING `Root({...})` as a
 * function inside its registered `Bootstrapped` component (not as a `<Root/>` element), handing it a
 * FRESH `readDeviceInfo` arrow on every render. `readDeviceInfo` is a dependency of Root's boot effect,
 * so each `setState` inside that effect re-renders `Bootstrapped`, rebuilds the arrow, and RE-FIRES the
 * boot effect. Every re-fire disposes the previous run before it can commit; the disposed run's
 * `if (!disposed) setDeviceInfo(info)` is skipped, so `deviceInfo` never lands and the render gate
 * (`deviceInfo === null → return null`) blanks the tree for good.
 *
 * The whole live-shell suite mounts Root through `mountRoot`, which renders a `<Root/>` ELEMENT — Root
 * gets its own fiber and a `readDeviceInfo` arrow built ONCE (live-shell-support.tsx), so the identity
 * never churns and the cascade cannot occur there. That is the exact "the test wires Root more stably
 * than production does" blind spot ([[bolusi-falsify-at-the-boundary]]).
 *
 * ── HOW THIS GUARDS IT ──────────────────────────────────────────────────────────────────────────
 * The live cascade is a pure-microtask infinite loop, so it cannot be observed from inside `act()`
 * (the queue never drains). Instead this test INDUCES the same dependency-identity churn
 * deterministically: mount the real `Root` element, let it settle, then `rerender` it with a FRESH
 * `readDeviceInfo` arrow several times — each rerender is one production re-render, bounded. The boot
 * effect must treat those identity-only changes as no-ops.
 *
 * It asserts `boot` is called EXACTLY ONCE across all the rerenders — the direct, deterministic
 * falsification of the root cause: `1 + rerenders` before the fix, `1` after. This is the same
 * "ref-stabilise the callback an effect keys on, then re-render with a fresh arrow" guard the sibling
 * `app-unlock-load.test.tsx` applies to `App`'s unlock callback ([[bolusi-root-app-unstable-callback-refire]]).
 */
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
  getExpoPushTokenAsync: vi.fn(async () => ({
    data: 'ExponentPushToken[boot-once]',
    type: 'expo',
  })),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import { Root, type RootProps } from '../src/bootstrap/Root.js';
import { type DeviceInfo } from '../src/screens/settings/model.js';
import {
  bootFixture,
  closeClientDb,
  fakeAppState,
  manualTimer,
  settle,
  type Bootstrapped,
  type Fixture,
} from './live-shell-support.js';
import { render } from '../../../packages/ui/test/render.js';

const DEVICE_INFO: DeviceInfo = {
  deviceId: '',
  deviceName: 'Konter Depan',
  storeName: 'Servis Ponsel Maju',
  tenantName: 'Maju Group',
  platform: 'android',
  appVersion: '0.0.0-test',
};

let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
});

describe('the shell boots ONCE despite readDeviceInfo identity churn (task 201)', () => {
  test('THE GUARD: re-rendering Root with a fresh readDeviceInfo arrow must not re-fire the boot effect', async () => {
    fixture = await bootFixture(); // UNENROLLED — exactly emulator flow 01-launch-enrollment.
    const target = fixture;
    let bootCount = 0;

    const base: Omit<RootProps, 'readDeviceInfo'> = {
      localeStore: { read: () => Promise.resolve(null), write: () => Promise.resolve() },
      // Returns the same booted app each call, so a re-fire's `setApp` is an `Object.is` no-op and can
      // never self-drive a second cascade — the rerenders below are the ONLY source of churn, keeping
      // the boot count a clean, bounded discriminator.
      boot: (): Promise<Bootstrapped> => {
        bootCount += 1;
        return Promise.resolve(target.app);
      },
      appState: fakeAppState(),
      timer: manualTimer(),
    };

    // A NEW arrow identity per call — exactly the fresh `(app) => readDeviceInfo(app, …)` that index.ts
    // rebuilds on every render.
    const freshReadDeviceInfo = (): RootProps['readDeviceInfo'] => () =>
      Promise.resolve(DEVICE_INFO);

    const screen = render(<Root {...base} readDeviceInfo={freshReadDeviceInfo()} />);
    await settle();

    // Precondition: the shell reached a rendered tree at all (`root-activity` wraps App once the gate
    // opens — locale + app + deviceInfo all non-null). Not the discriminator; the boot count is.
    expect(screen.query('root-activity')).not.toBeNull();

    // Each rerender hands Root a brand-new `readDeviceInfo` identity — the production re-render, one at
    // a time. A boot effect that keys on that identity re-fires here; a stabilised one does not.
    const RERENDERS = 3;
    for (let i = 0; i < RERENDERS; i += 1) {
      screen.rerender(<Root {...base} readDeviceInfo={freshReadDeviceInfo()} />);
      await settle();
    }

    // THE ROOT-CAUSE INVARIANT. Identity-only prop churn must not re-run the boot effect: exactly one
    // boot, ever. Before the fix this reads `1 + RERENDERS`; after, `1`.
    expect(bootCount).toBe(1);
  });
});
