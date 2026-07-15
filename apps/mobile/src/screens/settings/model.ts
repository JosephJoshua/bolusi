/**
 * Settings (07-i18n §1.1–1.2; api/04-push §3/§5).
 *
 * Three unglamorous jobs, one of which is load-bearing:
 *
 *  1. LANGUAGE. `id` is the default and the source language, not an afterthought (07-i18n §1). `zh`
 *     is scaffolded in the type and fallback chain but has NO catalog and is not selectable in v0 —
 *     so the toggle is driven by `SELECTABLE_LOCALES`, never by `LOCALES`. Rendering `LOCALES` would
 *     offer a language that resolves to nothing but key names, and the person who picked it could
 *     not read their way back to this screen to undo it. That is the entire reason this file reads
 *     one constant and not the other.
 *
 *  2. NOTIFICATION MUTING. Per api/04-push §5, muting is per-CATEGORY and expressed as Android
 *     channel importance — not as a server-side preference. The `sync` category is data-only (§3:
 *     "No" visible notification), so it has no channel and cannot be muted: offering a toggle for it
 *     would be a switch that does nothing, which is worse than no switch.
 *
 *  3. DEVICE INFO. Rendered from the enrollment persist so the shop can read its own device's
 *     identity to an owner over the phone during a revocation.
 */

import { SELECTABLE_LOCALES, type Locale } from '@bolusi/i18n';

/**
 * The locales the toggle offers. `SELECTABLE_LOCALES` is 07-i18n's own answer — this file does not
 * curate its own list, so `zh` joining in V2 is a change in ONE place (CLAUDE.md §2.8).
 */
export const localeOptions: readonly Locale[] = SELECTABLE_LOCALES;

/** The label key for a locale's display name. Endonyms — identical in every locale, deliberately. */
export function localeNameKey(locale: Locale): string {
  return `core.language.${locale}`;
}

/**
 * api/04-push §3's v0 categories that produce a VISIBLE notification, and therefore a channel a
 * user can mute. `sync` is absent by construction: it is a data-only wake with no title and no body.
 */
export const MUTABLE_PUSH_CATEGORIES = ['conflict', 'device'] as const;

export type MutablePushCategory = (typeof MUTABLE_PUSH_CATEGORIES)[number];

/** Muted state per category. Persisted locally and applied as channel importance (api/04-push §5). */
export type PushMuteState = Readonly<Record<MutablePushCategory, boolean>>;

export function defaultMuteState(): PushMuteState {
  // Nothing is muted by default: a conflict needing the owner's decision, and a device anomaly, are
  // the only two things the server ever interrupts anyone about. Both are already rare and both are
  // actionable — opting the shop out of them by default would make the feature pointless.
  return { conflict: false, device: false };
}

/**
 * api/04-push §5: muting is expressed as channel IMPORTANCE, not by dropping the notification.
 * `min` still delivers the payload — it simply does not interrupt — which keeps the deep link and
 * the badge working for a user who muted the noise but not the information.
 */
export type ChannelImportance = 'default' | 'min';

export function channelImportance(muted: boolean): ChannelImportance {
  return muted ? 'min' : 'default';
}

/** The label key for a category's channel name — reuses the push template titles (07-i18n §8). */
export function categoryNameKey(category: MutablePushCategory): string {
  return `push.${category}.title`;
}

/** What the device-info block renders, from the enrollment persist (api/02-auth §4.3's response). */
export interface DeviceInfo {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly storeName: string;
  readonly tenantName: string;
  readonly platform: 'android' | 'ios';
  readonly appVersion: string;
}

/**
 * The per-user locale preference — task 25's seam, NOT wired here.
 *
 * 07-i18n §1.1 gives each USER a locale preference carried by a `platform.setLocale` operation; §1.2
 * gives the DEVICE a plain-local-storage locale for the pre-login surfaces. This task ships the
 * device half only (its brief: "the op-emitting `platform.setLocale` per-user preference (25 wires
 * it; leave a seam)").
 *
 * The seam is a type and a null default rather than a TODO comment, so the scope guard is
 * assertable: `settings.test.ts` proves this is never invoked, which is what stops the op from being
 * emitted by accident before its module exists.
 */
export type SetLocalePreference = (locale: Locale) => Promise<void>;

export interface SettingsDeps {
  /** Writes the device locale (07-i18n §1.2). Plain local storage — never an op, never synced. */
  readonly setDeviceLocale: (locale: Locale) => Promise<void>;
  /** Applies channel importance (api/04-push §5). */
  readonly setChannelImportance: (
    category: MutablePushCategory,
    importance: ChannelImportance,
  ) => Promise<void>;
  /**
   * Task 25 passes the real emitter. Null here on purpose — see above. A non-null value in v0 would
   * mean an op type whose module is not registered yet.
   */
  readonly setLocalePreference: SetLocalePreference | null;
}

/**
 * Change the language. Writes the DEVICE locale only (§1.2) and deliberately does not touch the
 * per-user preference — see `SetLocalePreference`.
 */
export async function changeLocale(deps: SettingsDeps, locale: Locale): Promise<void> {
  await deps.setDeviceLocale(locale);
}

/** Toggle a category's mute, expressed as channel importance (api/04-push §5). */
export async function setMuted(
  deps: SettingsDeps,
  category: MutablePushCategory,
  muted: boolean,
): Promise<void> {
  await deps.setChannelImportance(category, channelImportance(muted));
}
