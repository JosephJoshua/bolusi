/**
 * The WEB entry — the react-native-web visual harness (task 116).
 *
 * This file replaces `index.ts` ONLY on web (Metro resolves `index.web.tsx` for the `web` platform;
 * `main: "index"` in package.json is extension-less so the platform variant wins — native still
 * resolves `index.ts`). It exists because `index.ts` binds op-sqlite/SecureStore/quick-crypto — JSI
 * native modules that cannot load in a browser — so web needs its own composition root that binds
 * in-memory fakes instead. Web is ADDITIVE: it changes nothing about the Android/iOS bundle.
 *
 * @expo/metro-runtime is imported first (Expo's web runtime shim); then i18n is booted at the URL's
 * locale BEFORE the app registers, because every screen resolves labels through `t()` (07-i18n).
 */
import '@expo/metro-runtime';
import { initI18n, isLocale, DEFAULT_LOCALE, type Locale } from '@bolusi/i18n';
import { registerRootComponent } from 'expo';

import { WebHarnessRoot } from './src/web/WebHarnessRoot.js';

function bootLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const requested = new URLSearchParams(window.location.search).get('locale');
  return requested !== null && isLocale(requested) ? requested : DEFAULT_LOCALE;
}

initI18n({ locale: bootLocale() });

registerRootComponent(WebHarnessRoot);
