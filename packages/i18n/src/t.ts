// The translate entrypoint (07-i18n §6).
import type { TranslationKey } from './generated/keys.js';
import { getI18nInstance, getLocale } from './instance.js';
import { DEFAULT_LOCALE } from './locale.js';
import { warnOnce } from './logger.js';

/**
 * ICU params. Values are `string` because dates/numbers/money arrive **pre-formatted** from the
 * §5 formatters — ICU argument formatting is banned (§3.2) and the ICU gate enforces it. `count`
 * is the exception: plural selection needs the real number.
 */
export type TranslationValues = Record<string, string | number>;

/**
 * Translate a catalog key. `key` is the generated union, so a typo is a compile error (§3.4).
 *
 * Fallback logging (§6): i18next resolves a key missing in the active locale through
 * `fallbackLng: 'id'` and considers it found, so `missingKeyHandler` never fires for that case —
 * it only fires when a key resolves nowhere. The active-locale probe below is what implements
 * "render the `id` value, log once per key per session" for `en`/`zh` gaps.
 */
export function t(key: TranslationKey, values?: TranslationValues): string {
  const i18n = getI18nInstance();
  const locale = getLocale();

  // `id` is complete by definition (§7.1), so the probe is skipped in the default case.
  if (locale !== DEFAULT_LOCALE && !i18n.exists(key, { lng: locale, fallbackLng: false })) {
    warnOnce(
      `fallback:${locale}:${key}`,
      `i18n: key '${key}' is missing in '${locale}'; rendering the '${DEFAULT_LOCALE}' value`,
      { key, locale },
    );
  }

  // Split rather than passing a possibly-undefined second argument: under
  // `exactOptionalPropertyTypes` i18next's overloads read `t(key, undefined)` as the
  // `defaultValue: string` overload.
  return values === undefined ? i18n.t(key) : i18n.t(key, values);
}

/** Whether a key exists in the given locale (no fallback). */
export function hasKey(key: string, locale?: string): boolean {
  return getI18nInstance().exists(key, {
    lng: locale ?? getLocale(),
    fallbackLng: false,
  });
}
