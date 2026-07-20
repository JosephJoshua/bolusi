// Push payload composition + the frozen v0 payload shape (api/04-push §4).
//
// THE ONE PLACE a push payload is built server-side. Every category is composed here and nowhere
// else, which is what makes the SEC-RT-03 audit total: `zComposedPush` (below) validates the output
// of these composers against api/04 §4's shape, and the test suite proves a payload that smuggles a
// business value (amount, name, note body) fails it. A push is NEVER a data plane (api/04 §1, §9):
// `data.params` carries entity ids ONLY, and title/body are generic, localized sentences pulled from
// the shared `@bolusi/i18n` `push.*` catalog — never a literal here (07-i18n §8). Because the
// composers take only a category + entity id + locale, a business value is STRUCTURALLY unable to
// enter the payload; the audit schema is the backstop that keeps it that way.
//
// LOCALE: title/body render in the recipient's last-synced `user_prefs.locale` (07-i18n §1.1, §8),
// fallback `id` — the compose functions take a resolved `Locale`, never an `Accept-Language` header
// (07-i18n §9: the server never negotiates locale). Locale resolution from a projection row lives in
// `resolveLocale` below so the fanout can pass what it read.
import {
  DEFAULT_LOCALE,
  getI18nInstance,
  initI18n,
  isLocale,
  type Locale,
  type TranslationKey,
} from '@bolusi/i18n';
import { pushChannelId } from '@bolusi/schemas';
import { z } from 'zod';

/** v0 category set (api/04-push §3). Closed — new categories are additive `/v1` changes. */
export const PUSH_CATEGORIES = ['sync', 'conflict', 'device'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/** Deep-link route registry (api/04-push §4). Visible categories only; `sync` has no route. */
export const PUSH_ROUTES = { conflict: 'conflicts', device: 'devices' } as const;

/**
 * `data` blocks per category (api/04-push §4). `sync` is data-only: `{ category }` and nothing else
 * — no `route`, no `params`. `conflict`/`device` carry a deep-link route key + entity ids ONLY.
 */
export type SyncPushData = { readonly category: 'sync' };
export type ConflictPushData = {
  readonly category: 'conflict';
  readonly route: 'conflicts';
  readonly params: { readonly conflictId: string };
};
export type DevicePushData = {
  readonly category: 'device';
  readonly route: 'devices';
  readonly params: { readonly deviceId: string };
};

/**
 * A composed push MINUS the recipient token (`to`), which the fanout attaches per device. `sync` is
 * data-only — no `title`, `body`, or `channelId`; the visible categories carry all three, and
 * `channelId` is `bolusi.<category>` — the shared `pushChannelId` scheme (`@bolusi/schemas`) the
 * mobile app also creates its Android channels under, so a delivered notification always routes to
 * the channel the user can mute (api/04-push §4/§5; task 107).
 */
export type ComposedPush =
  | { readonly data: SyncPushData }
  | {
      readonly data: ConflictPushData;
      readonly title: string;
      readonly body: string;
      readonly channelId: 'bolusi.conflict';
    }
  | {
      readonly data: DevicePushData;
      readonly title: string;
      readonly body: string;
      readonly channelId: 'bolusi.device';
    };

/** A composed push addressed to a device — what the `PushPort` sends. Carries `deviceId` so tickets
 *  and receipts can be mapped back to a row for invalidation (§8); `deviceId` is NOT serialized to
 *  the wire (the sender strips it). */
export interface OutgoingPush {
  readonly to: string;
  readonly deviceId: string;
  readonly push: ComposedPush;
}

// ── The SEC-RT-03 audit schema (api/04-push §4; security-guide §9.2) ─────────────────────────────
// Strict discriminated union: any extra key, missing key, or business-data smuggle FAILS. This is
// the schema every composed push is validated against; the audit test runs it over the output of
// the composers below and over hostile fixtures.
const zSyncData = z.strictObject({ category: z.literal('sync') });
const zConflictData = z.strictObject({
  category: z.literal('conflict'),
  route: z.literal('conflicts'),
  params: z.strictObject({ conflictId: z.uuid() }),
});
const zDeviceData = z.strictObject({
  category: z.literal('device'),
  route: z.literal('devices'),
  params: z.strictObject({ deviceId: z.uuid() }),
});

export const zComposedPush = z.discriminatedUnion('__kind', [
  z.strictObject({ __kind: z.literal('sync'), data: zSyncData }),
  z.strictObject({
    __kind: z.literal('conflict'),
    data: zConflictData,
    title: z.string().min(1),
    body: z.string().min(1),
    channelId: z.literal('bolusi.conflict'),
  }),
  z.strictObject({
    __kind: z.literal('device'),
    data: zDeviceData,
    title: z.string().min(1),
    body: z.string().min(1),
    channelId: z.literal('bolusi.device'),
  }),
]);

/** Tag a `ComposedPush` with its discriminant for the audit schema. Kept out of `ComposedPush`
 *  itself so the wire payload never carries an internal `__kind`. */
export function auditView(push: ComposedPush): Record<string, unknown> {
  return { __kind: push.data.category, ...push };
}

/** Validate a composed push against api/04 §4 (SEC-RT-03). Returns the Zod result. */
export function validateComposedPush(
  push: ComposedPush,
): ReturnType<typeof zComposedPush.safeParse> {
  return zComposedPush.safeParse(auditView(push));
}

// ── Locale resolution ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a `user_prefs` row's `locale` to a `Locale` (07-i18n §8). A null user_id, a missing row,
 * or a value outside the vocabulary all fall back to `DEFAULT_LOCALE` (`id`) — the recipient sees
 * Indonesian, never a raw key or a crash.
 */
export function resolveLocale(row: { readonly locale: string } | undefined): Locale {
  if (row !== undefined && isLocale(row.locale)) return row.locale;
  return DEFAULT_LOCALE;
}

// ── Composition ────────────────────────────────────────────────────────────────────────────────

/** Ensure the shared i18n instance exists (initI18n is idempotent by intent — the server composes
 *  push copy across many recipients from ONE catalog, 07-i18n §8). Lazy so no boot ordering is
 *  imposed on callers/tests. */
function ensureI18n(): void {
  try {
    getI18nInstance();
  } catch {
    initI18n();
  }
}

/** Render a `push.*` catalog key in a specific locale WITHOUT mutating the global active locale —
 *  the server renders for many recipients concurrently, so `setLocale`+`t` would race. i18next's
 *  per-call `{ lng }` override is stateless. Keys are the typed union, so a typo is a compile error;
 *  the string itself never appears literally here (07-i18n §8). */
function pushString(locale: Locale, key: TranslationKey): string {
  ensureI18n();
  return getI18nInstance().t(key, { lng: locale });
}

/** `sync` — data-only wake (api/04-push §3/§4). No title, body, route, params, or channel. */
export function composeSync(): ComposedPush {
  return { data: { category: 'sync' } };
}

/** `conflict` — visible; title/body from `push.conflict.*`, deep link to the conflict (api/04 §4).
 *  `channelId` derives from the shared `pushChannelId` scheme so it matches the mobile channel (107). */
export function composeConflict(conflictId: string, locale: Locale): ComposedPush {
  return {
    data: { category: 'conflict', route: 'conflicts', params: { conflictId } },
    title: pushString(locale, 'push.conflict.title'),
    body: pushString(locale, 'push.conflict.body'),
    channelId: pushChannelId('conflict'),
  };
}

/** `device` — visible; title/body from `push.device.*`, deep link to the device (api/04 §4).
 *  `channelId` derives from the shared `pushChannelId` scheme so it matches the mobile channel (107). */
export function composeDevice(deviceId: string, locale: Locale): ComposedPush {
  return {
    data: { category: 'device', route: 'devices', params: { deviceId } },
    title: pushString(locale, 'push.device.title'),
    body: pushString(locale, 'push.device.body'),
    channelId: pushChannelId('device'),
  };
}
