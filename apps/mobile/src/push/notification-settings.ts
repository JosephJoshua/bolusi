/**
 * Open the OS notification settings for a category — v0 muting (api/04-push §5; D18 §1).
 *
 * Muting is the OS's, not the app's: Android forbids an app changing a notification channel's
 * importance after the channel is created (importance belongs to the user), and iOS has no
 * per-category notification channels. So the in-app row does NOT set a mute flag — it hands the user
 * to the platform screen that actually owns the setting. On Android that screen is per-category,
 * because `bootstrap/notifications.ts` created one channel per visible category at boot; on iOS it is
 * the single app-level notification screen (the §5 stated limit — no per-category muting on iOS).
 *
 * `Platform.OS` selects the leg; `Linking` performs it (react-native 0.86 — `sendIntent` is Android
 * only, `openURL` is the cross-platform URL opener). Both are verified against the live RN types.
 */
import { Linking, Platform } from 'react-native';

/**
 * Our own Android application id. It must equal `app.config.ts`'s `android.package`; it is duplicated
 * here because v0 has no runtime source for it (`expo-constants` is deferred —
 * decisions/2026-07-20-appversion-source, the same gap that leaves `appVersion` empty).
 */
const APP_PACKAGE = 'com.bolusi.app';

/** Android intent that opens a single channel's notification settings (needs package + channel id). */
const ANDROID_CHANNEL_NOTIFICATION_SETTINGS = 'android.settings.CHANNEL_NOTIFICATION_SETTINGS';
const ANDROID_EXTRA_APP_PACKAGE = 'android.provider.extra.APP_PACKAGE';
const ANDROID_EXTRA_CHANNEL_ID = 'android.provider.extra.CHANNEL_ID';

/**
 * iOS notification-settings URL. `UIApplication.openNotificationSettingsURLString` (iOS 16+) has no
 * React Native binding, so we use `app-settings:` — the app's Settings root, one tap from
 * Notifications — which is the documented, version-safe fallback D18 §1 accepts and is exactly what
 * `expo-linking`'s `openSettings()` degrades to.
 */
const IOS_APP_SETTINGS_URL = 'app-settings:';

/**
 * Open the OS notification settings for `channelId`'s category. On Android this is that channel's own
 * settings screen (real per-category muting); on iOS it is the app-level notification screen and
 * `channelId` is not addressable (§5: no per-category iOS muting in v0).
 */
export async function openNotificationSettings(channelId: string): Promise<void> {
  if (Platform.OS === 'android') {
    await Linking.sendIntent(ANDROID_CHANNEL_NOTIFICATION_SETTINGS, [
      { key: ANDROID_EXTRA_APP_PACKAGE, value: APP_PACKAGE },
      { key: ANDROID_EXTRA_CHANNEL_ID, value: channelId },
    ]);
    return;
  }
  await Linking.openURL(IOS_APP_SETTINGS_URL);
}
