// Build-time configuration guards (08 §6.1). Node-safe and pure so the guard is TESTABLE — the raw
// value is a parameter, and index.ts (the native-binding site) reads `process.env` at the call site
// so Expo still inlines `EXPO_PUBLIC_*` at build.

/**
 * The server base URL, with any trailing slash trimmed. FAILS LOUD when unset (T-19).
 *
 * The value it replaces was `process.env['EXPO_PUBLIC_API_URL'] ?? ''` — an empty-string fallback that
 * yields a RELATIVE URL, so a build with the env var unset would silently POST enroll/sync to the
 * device itself and surface as a network failure. That is the `??`-on-a-value-you-failed-to-read shape
 * this session has been filing. An app with no server URL cannot enroll or sync: that is a boot-time
 * misconfiguration, not a runtime hiccup, and it must announce itself rather than degrade into a
 * plausible-looking wrong request.
 *
 * @throws {Error} when `raw` is `undefined` or blank.
 */
export function requireApiBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'EXPO_PUBLIC_API_URL is not set — the app has no server to reach (08 §6.1). Set it in the build environment; a relative URL would silently POST to the device itself.',
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * The EAS project id for `getExpoPushTokenAsync` (api/04-push §7), or `null` when unset.
 *
 * SOFT, not `require`d — the deliberate opposite of {@link requireApiBaseUrl}. Push is best-effort and
 * never load-bearing (api/04-push §1), so an unset project id must NOT crash the boot: it degrades to
 * "no push token registered" (registration.ts swallows the acquisition failure to `skipped`), and the
 * next app start retries once the id is present. `null` rather than an empty-string fallback so the
 * caller can SKIP wiring registration entirely instead of feeding `''` into the native token API
 * (`getExpoPushTokenAsync` throws "Project ID not found" on a blank id — the `??`-on-a-failed-read lie
 * this abstains from, T-19). The FCM/EAS credentials that make a real id meaningful land with task 21;
 * until then this reads `EXPO_PUBLIC_PROJECT_ID` (Expo inlines `EXPO_PUBLIC_*` at build, same
 * mechanism as the API URL) and is honestly `null` in a build that has not set it.
 */
export function pushProjectId(raw: string | undefined): string | null {
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}
