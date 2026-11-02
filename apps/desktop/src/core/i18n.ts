// The core's own translations. It runs in its own process, so the window's `initI18n` does not
// reach it, yet a few things it hands the window are already words: the servisan a refused change
// was about ("Servisan #…" in the sync status). Same locale and catalog as the window (main.tsx).
//
// The language is this PC's, as on the phone: saved in its own database and sent to the window
// with the core's state, so the window and the core always speak the same one.
import { readMeta, writeMeta } from '@bolusi/core';
import {
  DEFAULT_LOCALE,
  initI18n,
  isLocale,
  SELECTABLE_LOCALES,
  setLocale,
  type Locale,
} from '@bolusi/i18n';
import { registerRepairCatalog } from '@bolusi/modules/repair';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json' with { type: 'json' };
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json' with { type: 'json' };
import type { Kysely } from 'kysely';

/** Where this PC keeps the language it shows. */
export const DEVICE_LOCALE_META_KEY = 'device.locale';

export function initCoreI18n(): void {
  initI18n({ locale: DEFAULT_LOCALE });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
}

/** A locale someone may pick here; anything else (`zh` has no catalog yet) is not one. */
export function selectableLocale(value: unknown): Locale | null {
  return typeof value === 'string' &&
    isLocale(value) &&
    SELECTABLE_LOCALES.some((locale) => locale === value)
    ? value
    : null;
}

/** The language this PC was last set to, applied to the core's own words. */
export async function loadDeviceLocale<DB>(db: Kysely<DB>): Promise<Locale> {
  const saved = selectableLocale(await readMeta(db, DEVICE_LOCALE_META_KEY).catch(() => null));
  const locale = saved ?? DEFAULT_LOCALE;
  setLocale(locale);
  return locale;
}

/**
 * Save this PC's language for the next start. Applying it is the caller's, first, as on the phone:
 * a save that fails must not cost the person the language they just picked.
 */
export function saveDeviceLocale<DB>(db: Kysely<DB>, locale: Locale): Promise<void> {
  return writeMeta(db, DEVICE_LOCALE_META_KEY, locale);
}
