/**
 * The device-locale store (07-i18n §1.2) — "plain local storage", on expo-file-system.
 *
 * WHY expo-file-system AND NOT THE OBVIOUS CANDIDATES:
 *
 *  - NOT `@react-native-async-storage/async-storage`. It is the reflex answer and it is not pinned
 *    in 08 §2.2. Adding a dependency is a spec-table change requiring a stop-and-ask (CLAUDE.md
 *    §4/§6), and a one-key store does not justify one. `expo-file-system` is already a pinned dep.
 *
 *  - NOT `expo-secure-store`. It is available, but §1.2 is explicit that this is "plain local
 *    storage… unsigned UI state, not business truth". Which language a shop reads is not a secret,
 *    and putting it behind the Keystore would mean a keychain round trip on the boot path of the
 *    pre-login screens — the one path that must be fastest. SecureStore owns exactly two credentials
 *    (api/02-auth §3) and this is not one of them.
 *
 *  - NOT the SQLCipher DB. The pre-login surfaces render BEFORE the DB is opened (08 §6.3), so a
 *    locale living there could not be read in time to render them.
 *
 * Every operation FAILS SOFT. A missing file, a corrupt value, a full disk — none of it may stop a
 * device booting: `readDeviceLocale` (src/i18n.ts) already resolves the default on any failure, and
 * a failed WRITE means the toggle does not persist across restart, which is a bug, not an outage.
 */
import { Directory, File, Paths } from 'expo-file-system';

import type { LocaleStorePort } from '../i18n.js';

/** One small JSON object under the app's own document directory — never in a synced location. */
function storeFile(): File {
  return new File(Paths.document, 'bolusi-prefs.json');
}

async function readAll(): Promise<Record<string, string>> {
  try {
    const file = storeFile();
    if (!file.exists) return {};
    return JSON.parse(file.textSync()) as Record<string, string>;
  } catch {
    // A corrupt prefs file is not worth a crash loop; it is worth defaults.
    return {};
  }
}

export const fileLocaleStore: LocaleStorePort = {
  async read(key: string): Promise<string | null> {
    return (await readAll())[key] ?? null;
  },

  async write(key: string, value: string): Promise<void> {
    try {
      const next = { ...(await readAll()), [key]: value };
      const directory = new Directory(Paths.document);
      if (!directory.exists) directory.create({ intermediates: true });
      storeFile().write(JSON.stringify(next));
    } catch {
      // Non-fatal: the locale is applied in memory regardless (see writeDeviceLocale). The cost of
      // a failed write is that the choice does not survive a restart.
    }
  },
};
