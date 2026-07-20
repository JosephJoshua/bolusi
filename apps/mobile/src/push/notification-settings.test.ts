// The deep-link that IS v0 muting (api/04-push §5; D18 §1). Muting belongs to the OS — Android forbids
// an app changing a channel's importance post-creation, iOS has no per-category channels — so the
// in-app row opens the OS notification settings instead of pretending to be the switch.
//
// THE FALSIFIABLE CORE (§2.11 / T-14): the PLATFORM BRANCH. Android must open the channel-notification
// intent; iOS must open the app-settings URL. `react-native` is mocked so `Platform.OS` is driven and
// `Linking` is a spy — no native call, no device. Break the branch (Android takes the iOS path) and the
// Android assertion reds; that is the whole point of this file.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  os: { value: 'android' as 'android' | 'ios' },
  sendIntent: vi.fn(),
  openURL: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.os.value;
    },
  },
  Linking: {
    sendIntent: mocks.sendIntent,
    openURL: mocks.openURL,
  },
}));

import { openNotificationSettings } from './notification-settings.js';

beforeEach(() => {
  mocks.sendIntent.mockReset();
  mocks.sendIntent.mockResolvedValue(undefined);
  mocks.openURL.mockReset();
  mocks.openURL.mockResolvedValue(undefined);
});

describe('openNotificationSettings — the platform branch (api/04-push §5; D18 §1)', () => {
  test('ANDROID → the OS channel-notification-settings intent, addressed to our app + channel', async () => {
    mocks.os.value = 'android';

    await openNotificationSettings('bolusi.conflict');

    expect(mocks.sendIntent).toHaveBeenCalledTimes(1);
    const call = mocks.sendIntent.mock.calls[0]!;
    expect(call[0]).toBe('android.settings.CHANNEL_NOTIFICATION_SETTINGS');
    expect(call[1]).toEqual([
      { key: 'android.provider.extra.APP_PACKAGE', value: 'com.bolusi.app' },
      { key: 'android.provider.extra.CHANNEL_ID', value: 'bolusi.conflict' },
    ]);
    // The iOS URL path must NOT be taken on Android — a shared/uniform call would defeat the whole fix.
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  test('iOS → the app notification-settings URL (no per-category channels; §5 stated limit)', async () => {
    mocks.os.value = 'ios';

    await openNotificationSettings('bolusi.conflict');

    expect(mocks.openURL).toHaveBeenCalledTimes(1);
    expect(mocks.openURL).toHaveBeenCalledWith('app-settings:');
    // No Android intent on iOS — the branch is real.
    expect(mocks.sendIntent).not.toHaveBeenCalled();
  });
});
