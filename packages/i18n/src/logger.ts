// Diagnostics sink for missing-key and unknown-code events (07-i18n §6, §4.2).
//
// The default is a no-op rather than `console.warn`: this package is platform-free (08 §3.4,
// `types: []`, `lib: ES2022`), so `console` is not even in scope here. The app wires the real
// client diagnostics log at init; tests inject a spy.

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
