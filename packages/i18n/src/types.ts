// Wires the generated catalog shape through i18next's TS resource typing (07-i18n §3.4), so a
// bare `i18next.t('auth.pin.typo')` is a compile error and not just a runtime fallback.
import type { TranslationResources } from './generated/keys.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: TranslationResources };
    keySeparator: '.';
    // i18next's ns:/`:` machinery is deliberately unused — one default namespace, and the
    // namespace is just the first key segment (07-i18n §3.3).
    nsSeparator: false;
    returnNull: false;
  }
}
