// The push notification channel-id scheme (api/04-push §4/§5).
//
// ONE definition of how a push category maps to an Android notification channel id, imported by BOTH
// the server (payload composition, `apps/server/src/push/payload.ts`) and the mobile app (channel
// creation, `apps/mobile/src/bootstrap/notifications.ts`). It lives here — the same home this package
// gives the shared locale vocabulary (task 77, 08 §3.2) — so the two sides derive the id from one
// source and cannot drift (CLAUDE.md §2.8).
//
// WHY IT MATTERS: Android routes a delivered notification by EXACT `channelId`. A push whose
// `channelId` names a channel the device never created lands on a default channel, bypassing the
// per-category importance the user set in the OS notification settings — silently un-muting a
// category the user muted (api/04-push §5). The server `channelId` for a visible category must equal
// the mobile-created channel id byte for byte; deriving both through this function is what guarantees
// it (task 107). `sync` is data-only (api/04-push §3) and carries no `channelId` — only VISIBLE
// categories get a channel.

/**
 * The Android notification channel id for a visible push category: `bolusi.<category>` (api/04-push
 * §4/§5). The server sets this as the push `channelId`; the mobile app creates the channel under the
 * SAME id. The template-literal return type keeps the id a compile-time literal at every call site.
 */
export function pushChannelId<C extends string>(category: C): `bolusi.${C}` {
  return `bolusi.${category}`;
}
