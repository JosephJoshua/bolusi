// i18next setup and locale state (07-i18n §2, §6). The config block below is normative — it
// mirrors 07-i18n §2 line for line; change that doc first.
import i18next, { type i18n } from 'i18next';
import ICU from 'i18next-icu';

import { resources } from './generated/resources.js';
import { DEFAULT_LOCALE, type Locale } from './locale.js';
import { type I18nLogger, setI18nLogger, warnOnce } from './logger.js';
import './types.js';

export interface InitI18nOptions {
  /** §1.2 device locale pre-login, then the user's synced preference after a switch (§1.1). */
  locale?: Locale;
  /** Client diagnostics sink for fallback/missing-key events (§6). */
  logger?: I18nLogger;
}

let instance: i18n | undefined;

/**
 * Humanize a key's final segment for the §6 emergency degradation path.
 * `attemptsLeft` → `Attempts left`. The raw dotted key is never shown in production.
 */
export function humanizeKey(key: string): string {
  const segments = key.split('.');
  const leaf = segments[segments.length - 1] ?? key;
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Initialise the shared instance. One catalog, two runtimes: the mobile app and the Hono server
 * (push composition, §8) both call this.
 */
export function initI18n(options: InitI18nOptions = {}): i18n {
  setI18nLogger(options.logger);

  const i18nextInstance = i18next.createInstance();
  void i18nextInstance.use(ICU).init({
    lng: options.locale ?? DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    // i18next takes the resource store BY REFERENCE and mutates it: addResourceBundle merges
    // into it and removeResourceBundle deletes from it. Handing over the generated `resources`
    // object directly would let a module registering its catalog corrupt the shared, checked-in
    // source of truth for every other instance in the process (the server composes push copy for
    // many recipients). The catalogs are pure JSON, so a structural copy is both cheap and total.
    resources: JSON.parse(JSON.stringify(resources)) as typeof resources,
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    saveMissing: true,
    missingKeyHandler: (lngs, _ns, key) => {
      // Reached only when the key resolves in NO locale — the parity gate (§7.3) should have
      // failed the build first, so this is loud by design.
      warnOnce(`absent:${key}`, `i18n: key '${key}' is missing in every locale`, {
        key,
        locales: lngs,
      });
    },
    parseMissingKeyHandler: (key: string) => humanizeKey(key),
    // §3.3: single default namespace; the `ns:`/`:` separator machinery is not used.
    defaultNS: 'translation',
    ns: ['translation'],
    nsSeparator: false,
    keySeparator: '.',
    // Catalogs are bundled, never fetched (§3.3), so there is nothing to await: this makes
    // init and changeLanguage apply synchronously. Without it i18next defers both by a tick and
    // the language toggle renders one frame of stale copy.
    initAsync: false,
  });

  instance = i18nextInstance;
  return i18nextInstance;
}

export function getI18nInstance(): i18n {
  if (instance === undefined) {
    throw new Error('@bolusi/i18n: initI18n() must be called before any translation or formatting');
  }
  return instance;
}

export function getLocale(): Locale {
  return getI18nInstance().language as Locale;
}

/**
 * Change the active locale. Callers are the language toggle and the PIN-switch flow; persisting
 * the choice is the caller's job — device-level storage (§1.2) or the `platform.setLocale`
 * command that emits the synced preference op (§1.1). Neither lands in this package.
 */
export function setLocale(locale: Locale): void {
  void getI18nInstance().changeLanguage(locale);
}

/** Test seam — production has exactly one instance per process. */
export function resetI18nForTest(): void {
  instance = undefined;
}
