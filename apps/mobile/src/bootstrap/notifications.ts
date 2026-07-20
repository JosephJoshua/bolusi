/**
 * Per-category Android notification channels (api/04-push §3/§5).
 *
 * A channel must exist per VISIBLE category before the first notification arrives, because on Android
 * a channel's importance is fixed at creation and can afterwards be changed only by the USER in system
 * settings. That constraint IS §5's v0 muting model: the in-app row deep-links to the OS notification
 * settings (`src/push/notification-settings.ts`) — the app does NOT set importance, because Android
 * ignores a post-creation change (importance belongs to the user, by design; D18 §1). Creating one
 * channel per visible category at boot is what makes the OS settings screen offer PER-CATEGORY
 * controls; create one channel for everything and the shop's only choice is all-or-nothing, and create
 * them late and the first notification lands on a default channel the OS screen does not associate
 * with a category.
 *
 * `sync` gets NO channel, deliberately (§3: its "Visible notification" column is "No"). It is a
 * data-only wake; a channel for it would appear in Android's per-app settings as a switch that
 * silences nothing, and a user who found it would reasonably conclude the app lies.
 */
import * as Notifications from 'expo-notifications';

import { t } from '@bolusi/i18n';
import { pushChannelId } from '@bolusi/schemas';

import {
  categoryNameKey,
  channelImportance,
  MUTABLE_PUSH_CATEGORIES,
  type MutablePushCategory,
  type PushMuteState,
} from '../screens/settings/model.js';

/**
 * The Android channel id for a category — the shared `pushChannelId` scheme (`@bolusi/schemas`), the
 * SAME source the SERVER derives a push's `channelId` from, so the two never drift (CLAUDE.md §2.8;
 * task 107). Stable — a changed id is a NEW channel, defaults restored.
 */
export function channelId(category: MutablePushCategory): string {
  return pushChannelId(category);
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
