/**
 * The app's i18n bootstrap and the DEVICE locale (07-i18n §1.2).
 *
 * §1.2 is precise about what this is: "Before any user is present (enrollment screen, user switcher,
 * PIN pad), the UI renders in the device locale: the locale of the last active user, persisted in
 * plain local storage. Default `id`. This is unsigned UI state, not business truth — it is NOT an
 * operation and never syncs."
 *
 * Three consequences, all deliberate:
 *
 *  1. PLAIN STORAGE, NOT THE ENCRYPTED DB. The pre-login surfaces render BEFORE the SQLCipher key is
 *     read and the DB is opened (08 §6.3's bootstrap order). A locale living in the encrypted DB
 *     could not be read in time to render the switcher, so the first frame the shop sees every
 *     morning would be in the wrong language. It is also not a secret: which language a shop reads
 *     is not worth a key unwrap.
 *
 *  2. NOT AN OP. It never enters the log and never syncs. The per-USER preference (§1.1) is the one
 *     that does, via `platform.setLocale` — task 25's, not this task's (see settings/model.ts).
 *
 *  3. DEFAULT `id`, ALWAYS. A fresh device, an unreadable value, a value naming a locale we do not
 *     ship — all resolve to Indonesian. There is no device-language sniffing: an Android phone sold
 *     in Indonesia is often configured in English by whoever set it up, which says nothing about the
 *     person who will use it at the counter. Guessing wrong here means a tech-inadept user faces an
 *     English enrollment wizard on the one screen that has to work.
 */

import {
  DEFAULT_LOCALE,
  initI18n,
  isLocale,
  SELECTABLE_LOCALES,
  setLocale,
  type Locale,
} from '@bolusi/i18n';

/** The storage key for the device locale. */
export const DEVICE_LOCALE_KEY = 'bolusi.device_locale';

/**
 * Plain key-value storage, injected.
 *
 * A port rather than a direct `expo-secure-store` / async-storage import, for the usual reason: this
 * module must be drivable from Node in the test lane. It is also honest about the requirement —
 * §1.2 says "plain local storage", and the port's shape is the whole of what that needs.
 */
export interface LocaleStorePort {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/**
 * Read the persisted device locale, or the default.
 *
 * FAILS SOFT, ALWAYS. A storage read that throws, returns garbage, or names `zh` (scaffolded but
 * catalogue-less in v0) resolves to `id` rather than propagating. Nothing about a language
 * preference justifies blocking the boot of a device the shop needs to take payments on.
 */
export async function readDeviceLocale(store: LocaleStorePort): Promise<Locale> {
  try {
    const stored = await store.read(DEVICE_LOCALE_KEY);
    if (stored === null || !isLocale(stored)) return DEFAULT_LOCALE;
    // `isLocale` admits `zh`, which has no catalog in v0 (07-i18n §1). Persisted or not, it must
    // never become the active locale — every string would render as a humanized key name, and the
    // user could not read their way back to Settings to undo it.
    if (!isSelectable(stored)) return DEFAULT_LOCALE;
    return stored;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Persist the device locale and apply it immediately (§1.2). */
export async function writeDeviceLocale(store: LocaleStorePort, locale: Locale): Promise<void> {
  await store.write(DEVICE_LOCALE_KEY, locale);
  // Applied synchronously — `initAsync: false` (i18n instance.ts) means the toggle re-renders in
  // the same frame rather than showing one frame of the old language.
  setLocale(locale);
}

/** Is `locale` one a v0 user may actually be shown? Delegates to 07-i18n's own list, never a copy. */
function isSelectable(locale: Locale): boolean {
  // `.some`, not `.includes`: SELECTABLE_LOCALES is a const tuple (`readonly ['id','en']`), so
  // `.includes` would narrow its argument to `'id' | 'en'` and reject a `Locale` that could be `zh`.
  return SELECTABLE_LOCALES.some((selectable) => selectable === locale);
}

/**
 * Boot i18n at the device locale (08 §6.3 step order: this runs BEFORE the first pre-login render).
 * Returns the locale actually applied, so the caller can log what the shop will see.
 */
export async function bootstrapI18n(store: LocaleStorePort): Promise<Locale> {
  const locale = await readDeviceLocale(store);
  initI18n({ locale });
  return locale;
}
