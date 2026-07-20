// The app's ONE client diagnostics channel — the concrete "client diagnostics log" that two
// platform-free packages have been naming as an injected seam with a no-op default.
//
// ── WHY THIS FILE EXISTS (T-16: a mention is not a producer) ─────────────────────────────────────
// `@bolusi/core`'s `DenialAuditDiagnosticsPort` (task 99) and `@bolusi/i18n`'s `I18nLogger` both
// describe themselves as "the app wires its real client diagnostics log at init". Until this file,
// NO app did: `createAppRuntime` passed no `denialAuditDiagnostics` and `bootstrapI18n` called
// `initI18n({ locale })` with no `logger`, so BOTH seams sat on their no-op default in the shipping
// app. A lost FR-1045 denial audit and a missing i18n key were equally unobservable on-device. The
// mechanisms were built, tested and merged; they were also inert (CLAUDE.md §2.11 — "typed and
// compiling is not running on the target"). This is the binding that activates them.
//
// ── ONE CHANNEL, NOT TWO (§2.8) ─────────────────────────────────────────────────────────────────
// Both seams take the SAME sink. `DenialAuditDiagnosticsPort` is adapted onto it here rather than
// given its own writer, so there is exactly one place that decides where a client diagnostic goes.
//
// ── WHAT THIS IS AND IS NOT, HONESTLY ───────────────────────────────────────────────────────────
// It is a structured `console.warn`. That is the whole v0 implementation and it is deliberately the
// smallest honest thing: there is no crash reporter, no remote log sink, and no on-device log buffer
// in this repo, so anything grander would be a comment describing software that does not exist. What
// it buys today: the record is visible in `adb logcat` / the Expo dev client, and — because every
// producer now routes through ONE named object — adding a real backend later is a change to this
// file alone, not a hunt through call sites. A remote/persisted diagnostics backend is a separate,
// outward-facing decision (CLAUDE.md §6) and is NOT claimed here.
//
// NOT AN AUDIT RECORD. Nothing written here syncs, is signed, or is retained. 02 §7 rejects a second
// denial channel; these are diagnostics ABOUT a lost record, never the record itself.
import type { DenialAuditDiagnosticsPort, DenialAuditFailure } from '@bolusi/core';

/**
 * Where a client diagnostic goes. Structurally satisfies `@bolusi/i18n`'s `I18nLogger` (same
 * `warn(message, meta?)` shape), which is how one binding serves both seams without either package
 * importing the other.
 */
export interface ClientDiagnostics {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The v0 sink: a structured `console.warn`. Node- and RN-safe; no native module, no import gate. */
export const consoleDiagnostics: ClientDiagnostics = {
  warn(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) {
      console.warn(`[bolusi] ${message}`);
      return;
    }
    console.warn(`[bolusi] ${message}`, meta);
  },
};

/**
 * Adapt a `ClientDiagnostics` into core's `DenialAuditDiagnosticsPort` (task 99).
 *
 * Every field of the record is forwarded: `outcome` distinguishes a broken store from a wedged one
 * (they need different operator responses), and `consecutiveFailures` is the number that separates
 * FR-1045's tolerated single transient loss from the climbing run that means the denial-audit trail
 * is going incomplete.
 *
 * A factory over `ClientDiagnostics` rather than a direct `console` writer, so the adaptation and the
 * choice of backend stay separable when a real backend arrives. NOT exported: the tests that matter
 * drive the PRODUCTION binding below through the real `createAppRuntime` composition and observe the
 * console itself — a test that bound its own spy sink here would prove only that a double can be
 * called, which is exactly the inert-mechanism trap this task exists to close.
 *
 * **Must not throw** — core guards the call, but a sink that relies on that guard is a sink that can
 * silently swallow itself. Everything here is a plain property read plus one `console.warn`.
 */
function createDenialAuditDiagnostics(sink: ClientDiagnostics): DenialAuditDiagnosticsPort {
  return {
    auditAppendFailed(failure: DenialAuditFailure): void {
      sink.warn('denial audit append lost — the FR-1045 trail is incomplete', {
        outcome: failure.outcome,
        consecutiveFailures: failure.consecutiveFailures,
        userId: failure.userId,
        permissionId: failure.permissionId,
        target: failure.target,
        surface: failure.surface,
        reason: failure.reason,
        scopeStoreId: failure.scopeStoreId,
        // `undefined` when the outcome is `timed_out` — there is no rejection to report.
        error: failure.error,
      });
    },
  };
}

/** The production binding, over the one channel above. Wired at `createAppRuntime` (bootstrap/runtime.ts). */
export const denialAuditDiagnostics = createDenialAuditDiagnostics(consoleDiagnostics);
