// Locale model (07-i18n §1). Adding a locale is a change to that doc first, then this file.

/** BCP 47 primary language subtags — never a region tag; region is a formatting concern (§5). */
export type Locale = 'id' | 'en' | 'zh';

/** `zh` is scaffolded (type + fallback chain) but has no catalog and is not selectable in v0. */
export const LOCALES: readonly Locale[] = ['id', 'en', 'zh'];

/** Source language, default, and the tail of every fallback chain (§1, §6). */
export const DEFAULT_LOCALE: Locale = 'id';

/** Offered by the in-app toggle in v0 (§1). `zh` joins in V2. */
export const SELECTABLE_LOCALES: readonly Locale[] = ['id', 'en'];

/**
 * Intl locale tag per locale (§1, §5.2). `en` maps to `en-GB` deliberately: dates are day-first
 * in both locales because the business operates in Indonesia, and US month-first is ambiguous.
 */
export const INTL_LOCALE_TAG: Record<Locale, string> = {
  id: 'id-ID',
  en: 'en-GB',
  zh: 'zh-CN',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
