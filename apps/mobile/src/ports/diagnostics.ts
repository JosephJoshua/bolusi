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
// it buys today: the record is visible in the Expo dev client / Metro (NOT a release APK's logcat — a
// React Native release build does not flush JS `console` there, proven by task 201's lane run
// 34153987393; the TEMPORARY native mirror below exists for exactly that gap), and — because every
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

/**
 * TEMPORARY — task 201 session-open diagnosis. A React Native RELEASE build does NOT flush JS
 * `console.warn` to logcat (proven empirically: android-emulator lane run 34153987393 captured ZERO
 * `[bolusi]` lines while the a061555 session-open instrumentation was live), so those boundary logs
 * were invisible on device. Every diagnostic is ALSO mirrored to Android logcat via the `HarnessNative`
 * local Expo module (`android.util.Log.i`), the one channel that survives release — the same one
 * `src/harness/emit.ts` relies on. Maestro's `device-logcat.txt` is unfiltered, so a `BOLUSI_DIAG` line
 * is captured in the run's artifact.
 *
 * WHY A SETTABLE SINK, not a call into a native module HERE. This file is in the Node import graph of
 * dozens of un-mocking tests (i18n, runtime, session, notes); `expo`'s entry runs `async-require/setup`
 * which reads the Metro-only `__DEV__` global → `ReferenceError: __DEV__ is not defined` at COLLECTION.
 * The previous attempt used a dynamic `import('expo').…catch(() => {})`, which kept the static graph
 * clean but produced ZERO device output (lane run 34158006328) AND hid its own failure behind the silent
 * `.catch` — the exact §2.11 anti-pattern (a diagnostic whose failure is invisible cannot be told apart
 * from "the code never ran"). So the expo import now lives in the device-only `src/harness/native-diag.ts`
 * (which no Node test imports) and is INJECTED here by the app entry (`index.ts`) via
 * `setNativeDiagnosticsMirror`. Node never reaches expo; device gets `emit.ts`'s proven static path.
 * Reverted together with the a061555 instrumentation once the failing branch is identified.
 */
let nativeMirror: ((line: string) => void) | null = null;

/**
 * Inject the device-only native logcat sink. Called once, at app boot, from `index.ts` — the one entry
 * no Node test imports. Left `null` everywhere else (tests, RNW), so `warn` stays a pure `console.warn`.
 */
export function setNativeDiagnosticsMirror(mirror: ((line: string) => void) | null): void {
  nativeMirror = mirror;
}

/** The v0 sink: a structured `console.warn`, mirrored to native logcat on device (see note above). */
export const consoleDiagnostics: ClientDiagnostics = {
  warn(message: string, meta?: Record<string, unknown>): void {
    if (meta === undefined) {
      console.warn(`[bolusi] ${message}`);
    } else {
      console.warn(`[bolusi] ${message}`, meta);
    }
    nativeMirror?.(meta === undefined ? message : `${message} ${JSON.stringify(meta)}`);
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
