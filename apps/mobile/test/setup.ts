/**
 * Test-lane setup: boot the real i18n instance before any suite runs.
 *
 * `@bolusi/i18n` throws "initI18n() must be called before any translation or formatting" rather than
 * lazily self-initialising — which is the right call (a screen that renders before the locale is
 * resolved would flash the wrong language), but it means every suite touching `t`/`hasKey` needs the
 * instance up first. The APP does this in `src/i18n.ts`'s `bootstrapI18n`; the test lane does it here.
 *
 * The REAL catalogs are used, never a fixture. That is deliberate: the key-existence suite
 * (`src/screens/rejection-keys.test.ts`) exists precisely to catch a key that is missing from the
 * shipping catalog, and a fixture catalog would answer "yes, that key exists" about a file nobody
 * ships. The oracle has to be the thing under test (T-13).
 *
 * `id` is the boot locale here for the same reason it is on a fresh device (07-i18n §1.2): it is the
 * default, and a suite that boots in `en` would not notice an `id` gap.
 */
import { DEFAULT_LOCALE, initI18n } from '@bolusi/i18n';

initI18n({ locale: DEFAULT_LOCALE });
