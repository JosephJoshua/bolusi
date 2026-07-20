// Diagnostics sink for missing-key and unknown-code events (07-i18n §6, §4.2).
//
// The default is a no-op rather than `console.warn`: this package is platform-free (08 §3.4,
// `types: []`, `lib: ES2022`), so `console` is not even in scope here. Tests inject a spy.
//
// WHO BINDS THIS IN PRODUCTION, precisely (T-15 — no aspirational comment stated as fact; this one
// previously claimed "the app wires the real client diagnostics log at init" while NO app passed a
// `logger`, so every §6 warning went to the no-op below and was unobservable on-device):
//
//   apps/mobile — `bootstrapI18n` (src/i18n.ts) passes `consoleDiagnostics` (src/ports/diagnostics.ts),
//     the app's one client diagnostics channel, shared with the command runtime's denial-audit sink
//     (§2.8). v0's "client diagnostics log" is a structured `console.warn` and nothing more: it is
//     visible in `adb logcat` / the dev client, and it is NOT persisted, buffered, or sent anywhere.
//     Do not cite it as remote or retained observability.
//   apps/server — `ensureI18n` (src/push/payload.ts) calls `initI18n()` with NO logger, so on the
//     server this sink is still the no-op. Server-side push-copy fallbacks are unobserved today.

export interface I18nLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: I18nLogger = { warn: () => {} };

let logger: I18nLogger = NOOP_LOGGER;

export function setI18nLogger(next: I18nLogger | undefined): void {
  logger = next ?? NOOP_LOGGER;
}

export function getI18nLogger(): I18nLogger {
  return logger;
}

/**
 * Keys already reported this session. §6 requires one log per key per session — a missing key on
 * a list row would otherwise log once per render and drown the diagnostics log.
 */
const reported = new Set<string>();

/** Log `message` at most once for `slot` per session. Returns true when it actually logged. */
export function warnOnce(slot: string, message: string, meta?: Record<string, unknown>): boolean {
  if (reported.has(slot)) return false;
  reported.add(slot);
  logger.warn(message, meta);
  return true;
}

/** Test seam — a session boundary is process lifetime in production. */
export function resetWarnOnceState(): void {
  reported.clear();
}
