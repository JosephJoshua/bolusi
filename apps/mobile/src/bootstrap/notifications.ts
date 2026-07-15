/**
 * Per-category Android notification channels (api/04-push §3/§5).
 *
 * §5's muting model is channel importance, not server-side suppression — which is why a channel must
 * exist per VISIBLE category before the first notification arrives: on Android a channel's importance
 * is fixed at creation and can afterwards only be changed by the USER in system settings. Create one
 * channel for everything and the shop's only choice is all-or-nothing; create them late and the first
 * notification lands on a default channel the mute toggle does not control.
 *
 * `sync` gets NO channel, deliberately (§3: its "Visible notification" column is "No"). It is a
 * data-only wake; a channel for it would appear in Android's per-app settings as a switch that
 * silences nothing, and a user who found it would reasonably conclude the app lies.
 */
import * as Notifications from 'expo-notifications';

import { t } from '@bolusi/i18n';

import {
  categoryNameKey,
  channelImportance,
  MUTABLE_PUSH_CATEGORIES,
  type MutablePushCategory,
  type PushMuteState,
} from '../screens/settings/model.js';

/** The Android channel id for a category. Stable — a changed id is a NEW channel, defaults restored. */
export function channelId(category: MutablePushCategory): string {
  return `bolusi.${category}`;
}

/** Map our two-state importance onto Expo's enum. */
function androidImportance(muted: boolean): Notifications.AndroidImportance {
  return channelImportance(muted) === 'min'
    ? Notifications.AndroidImportance.MIN
    : Notifications.AndroidImportance.DEFAULT;
}

/**
 * Create (or update) one channel per visible category. Idempotent — Expo's
 * `setNotificationChannelAsync` upserts, so this is safe on every boot, which is what keeps the
 * channels correct after an app update adds a category.
 *
 * Channel NAMES come from the label catalog: they are user-visible strings that Android renders in
 * its own settings UI, outside our screens entirely — which makes them the easiest user-visible copy
 * in the app to hardcode by accident (the lint rule does not read Android's settings screen).
 */
export async function createNotificationChannels(muted: PushMuteState): Promise<readonly string[]> {
  const created: string[] = [];
  for (const category of MUTABLE_PUSH_CATEGORIES) {
    const id = channelId(category);
    await Notifications.setNotificationChannelAsync(id, {
      name: t(categoryNameKey(category) as 'push.device.title'),
      importance: androidImportance(muted[category]),
    });
    created.push(id);
  }
  return created;
}

/** Apply a mute toggle (api/04-push §5) — the Settings screen's `setChannelImportance` binding. */
export async function applyChannelImportance(
  category: MutablePushCategory,
  muted: boolean,
): Promise<void> {
  await Notifications.setNotificationChannelAsync(channelId(category), {
    name: t(categoryNameKey(category) as 'push.device.title'),
    importance: androidImportance(muted),
  });
}
