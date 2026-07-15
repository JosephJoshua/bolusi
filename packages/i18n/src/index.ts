// @bolusi/i18n — the localization mechanism (ai-docs/07-i18n.md).
//
// Platform-free: no RN imports (08 §3.4). The react-i18next binding is the mobile app's, and the
// Hono server uses this bare instance to compose push copy (§8) — one catalog, two runtimes.
export type { Locale } from './locale.js';
export {
  DEFAULT_LOCALE,
  INTL_LOCALE_TAG,
  LOCALES,
  SELECTABLE_LOCALES,
  isLocale,
} from './locale.js';

export type { TranslationKey, TranslationResources } from './generated/keys.js';

export type { InitI18nOptions } from './instance.js';
export { getI18nInstance, getLocale, humanizeKey, initI18n, setLocale } from './instance.js';

export type { I18nLogger } from './logger.js';
export { setI18nLogger } from './logger.js';

export type { TranslationValues } from './t.js';
export { hasKey, t } from './t.js';

export { translateErrorCode, translateRejectionCode } from './errors.js';

export {
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
} from './formatters.js';
