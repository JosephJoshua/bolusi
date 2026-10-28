// Boot the real i18n instance before any suite runs: `@bolusi/i18n` throws rather than initialising
// lazily, and the device core resolves copy (sync problems, slip labels) through it.
import { DEFAULT_LOCALE, initI18n } from '@bolusi/i18n';

initI18n({ locale: DEFAULT_LOCALE });
