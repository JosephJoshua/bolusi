// Locale model (07-i18n §1). The vocabulary itself — Locale, LOCALES, DEFAULT_LOCALE,
// SELECTABLE_LOCALES, isLocale — lives in @bolusi/schemas, the zod-only platform-free package that
// @bolusi/core ALSO imports (the setLocale / user_locale_changed enums), so the in-app toggle and the
// op payload cannot drift (CLAUDE.md §2.8; task 77 — it was two hardcoded copies). This file
// re-exports that vocabulary and keeps the Intl-tag mapping + i18next wiring, which are i18n's own.
// Adding a locale is a change to 07-i18n §1 first, then @bolusi/schemas' locale.ts.
export {
  type Locale,
  LOCALES,
  DEFAULT_LOCALE,
  SELECTABLE_LOCALES,
  isLocale,
} from '@bolusi/schemas';

import type { Locale } from '@bolusi/schemas';

/**
 * Intl locale tag per locale (§1, §5.2). `en` maps to `en-GB` deliberately: dates are day-first
 * in both locales because the business operates in Indonesia, and US month-first is ambiguous.
 */
export const INTL_LOCALE_TAG: Record<Locale, string> = {
  id: 'id-ID',
  en: 'en-GB',
  zh: 'zh-CN',
};
