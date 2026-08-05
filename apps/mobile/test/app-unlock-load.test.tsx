// The owner-Unlock target-list load fires ONCE PER ENTRY, not on every re-render (task 186b-1 review
// fix). `Root` hands `<App>` a fresh inline `listPinTargets` arrow on every render, and `App` re-renders
// on every Root `bump()` (a sync tick, a pulled op, the unlock's own `clearLockout` emit). Before the
// fix the entry effect keyed on the loader's identity, so each such re-render tore the list back to its
// spinner and re-read the DB (last-write-wins race). This test mounts the REAL `App`, jumps to the
// Unlock route, and re-renders with a NEW loader arrow each time — asserting the spy is called once on
// entry and NOT again on an unrelated re-render. It reds on the pre-fix code (loader in the effect deps).
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

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

import App, { type AppProps } from '../App.js';
import type { PinTargetUser } from '../src/screens/pin/pin-target.js';
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

/** Flush pending microtasks/effects so the async load settles. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

let listPinTargets: Mock<() => Promise<readonly PinTargetUser[]>>;

/**
 * A full `AppProps` on the shell (session open, owner). `listPinTargets` is wrapped in a FRESH arrow
 * each call — the whole point: it mimics `Root`'s unmemoized inline prop, so a stable loader is the only
 * thing that keeps the entry effect from re-firing.
 */
function props(extra: Partial<AppProps> = {}): AppProps {
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
    listPinTargets: () => listPinTargets(),
    onClearLockout: () => Promise.resolve(),
    onSelectLocale: noop,
    locale: 'id',
    deviceInfo: DEMO_DEVICE_INFO,
    enrollment: fakeEnrollmentController(),
    ...extra,
  };
}

beforeEach(() => {
  listPinTargets = vi.fn<() => Promise<readonly PinTargetUser[]>>(() =>
    Promise.resolve([] as readonly PinTargetUser[]),
  );
});

let screen: RenderResult | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
});

describe('owner-Unlock target-list load (task 186b-1 review fix)', () => {
  test('loads once on entry and NOT again on an unrelated re-render with a fresh loader arrow', async () => {
    // A stable pushRoute object so a re-render does NOT re-navigate — only the loader arrow + `now` change.
    const toUnlock = { route: 'unlockPin' as const };
    screen = render(<App {...props({ pushRoute: toUnlock })} />);
    await flush();
    expect(screen.query('clear-lockout-screen')).not.toBeNull();
    expect(listPinTargets).toHaveBeenCalledTimes(1); // entry load

    // Re-render as Root would on a background bump: a NEW `listPinTargets` arrow (props() builds one),
    // an unrelated prop change (`now`), the SAME pushRoute object (no re-navigation). The stable loader
    // means the entry effect must NOT re-fire. On the pre-fix code (effect dep = the changing loader),
    // this reloads and the count climbs.
    screen.rerender(<App {...props({ pushRoute: toUnlock, now: HARNESS_NOW + 1 })} />);
    await flush();
    screen.rerender(<App {...props({ pushRoute: toUnlock, now: HARNESS_NOW + 2 })} />);
    await flush();
    expect(listPinTargets).toHaveBeenCalledTimes(1); // still once — re-renders did not reload
  });

  test('re-entering the screen reloads — the load is per-entry, not once-forever', async () => {
    // Enter → load (1). A fresh pushRoute object drives each navigation.
    screen = render(<App {...props({ pushRoute: { route: 'unlockPin' } })} />);
    await flush();
    expect(listPinTargets).toHaveBeenCalledTimes(1);

    // Leave to Settings, then come back — a new entry must load again (the cleanup reset + on-entry load).
    screen.rerender(<App {...props({ pushRoute: { route: 'settings' } })} />);
    await flush();
    screen.rerender(<App {...props({ pushRoute: { route: 'unlockPin' } })} />);
    await flush();
    expect(screen.query('clear-lockout-screen')).not.toBeNull();
    expect(listPinTargets).toHaveBeenCalledTimes(2); // one load per entry
  });
});
