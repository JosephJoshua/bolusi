// A live system font-size change left Android text laid out at the old size (second QA run).
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
  test('remounts the screens so every text is measured at the new size; a re-render alone does not', () => {
    act(() => {
      screen = render(<App {...props()} />);
    });
    const zone = (): unknown =>
      screen!.container
        .queryAll((n) => n.props['style'] !== undefined)
        .find((n) => n.parent?.props['testID'] === 'bolusi-app-shell');
    const before = zone();
    expect(before).toBeDefined();

    screen!.rerender(<App {...props()} />);
    expect(zone()).toBe(before);

    __windowMetrics.fontScale = 1.3;
    screen!.rerender(<App {...props()} />);
    expect(zone()).toBeDefined();
    expect(zone()).not.toBe(before);
  });
});
