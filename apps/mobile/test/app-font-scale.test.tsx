// A live system font-size change left Android text laid out at the old size (second QA run), and
// remounting the whole screen for it dropped an open form (QA on PR #93).
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

import { FontScaleProvider } from '@bolusi/ui';

import App, { type AppProps } from '../App.js';
import { render, type RenderResult } from '../../../packages/ui/test/render.js';
import { __windowMetrics } from './doubles/react-native.js';
import {
  DEMO_DEVICE_INFO,
  DEMO_USERS,
  HARNESS_NOW,
  demoSyncInput,
  fakeEnrollmentController,
} from '../src/web/seed.js';

const noop = (): void => undefined;

function props(): AppProps {
  return {
    device: 'active',
    users: DEMO_USERS,
    usersError: null,
    pinRow: () => null,
    now: HARNESS_NOW,
    session: { userId: DEMO_USERS[0]!.id },
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

let screen: RenderResult | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
  __windowMetrics.fontScale = 1;
});

describe('a system font-size change', () => {
  test('keeps the screens mounted; only the text is drawn afresh', () => {
    const app = (): React.JSX.Element => (
      <FontScaleProvider>
        <App {...props()} />
      </FontScaleProvider>
    );
    act(() => {
      screen = render(app());
    });
    // The native nodes themselves: the test renderer's wrappers are not kept across updates.
    const zone = (): unknown =>
      screen!.container
        .queryAll((n) => n.props['style'] !== undefined)
        .find((n) => n.parent?.props['testID'] === 'bolusi-app-shell')?.unstable_fiber?.stateNode;
    const before = zone();
    expect(before).toBeDefined();

    __windowMetrics.fontScale = 1.3;
    screen!.rerender(app());
    expect(zone()).toBe(before);
  });
});
