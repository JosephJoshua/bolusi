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
