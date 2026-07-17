// The platform sync-trigger adapters (api/01-sync §5) — the layer that turns device events into
// `SyncLoop.requestSync(reason)`.
//
// @bolusi/core owns the loop and no timers (08 §3.3 rule 3); this file owns the *when*. Everything
// effectful arrives as a port so the whole trigger set runs under a fake timer with zero sleeping
// (T-6: a test that sleeps is a bug).
//
// ── §5's FIVE TRIGGERS: WHAT IS WIRED AND WHAT IS ABSENT ──────────────────────────────────────
// Stated here in full, because four of these are built and one is not, and a reader must not have to
// infer which. Absent is loud; a working-looking fake is silent (task 24's standard).
//
//   (a) connectivity regained (NetInfo listener)  — **WIRED** (task 89), `start()` subscribes
//       `@react-native-community/netinfo` (12.0.1, 08 §2.2). `requestSync('connectivity')` fires on a
//       transition INTO connectivity — including the first reading at boot, which is what kicks the
//       initial sync when the app opens online. NetInfo autolinks (no Expo config plugin) and the
//       adapter is `ports/netinfo.ts` (a native module, injected like op-sqlite).
//   (b) debounced 3 s after any local append          — **WIRED**, `scheduler` (04 §5.1 step 7).
//   (c) periodic every 60 s while online + foreground — **WIRED**, `start()`.
//   (d) background task, best-effort                  — **NOT BUILT.** The deps are installed, but
//       `TaskManager.defineTask` is a process-global registration and task 82 owns
//       "background-task registration" for the media drain. Two files defining tasks independently
//       is a collision, so this is coordinated rather than raced. 08 §2.2 is explicit that this
//       trigger is "never a correctness dependency" — the foreground loop is the primary driver —
//       so its absence costs opportunistic retries, not correctness.
//   (e) manual pull-to-refresh                        — **WIRED**, `requestManual()`.
//
// WHY (a) MATTERS, now that it is wired: `EARLY_EXIT_REASONS` (03 §10) is `{manual, connectivity}`,
// so a device inside a 5-minute backoff resumes the moment the network returns rather than waiting
// out the timer. Connectivity and a human pressing refresh are the two signals that carry NEW
// information ("the reason for the wait may be gone"); a periodic tick is deliberately absorbed so a
// failing server is not hammered every minute. (d)'s remaining absence costs only opportunistic
// background retries, never data — ops are durable locally the moment they commit (design-system §4).
import type { SyncSchedulerPort, SyncTriggerReason, TimerPort } from '@bolusi/core';

/** api/01-sync §5 (b): "debounced 3 s after any local append". */
export const APPEND_DEBOUNCE_MS = 3_000;

/** api/01-sync §5 (c): "periodic every 60 s while online and app foregrounded". */
export const FOREGROUND_INTERVAL_MS = 60_000;

/** RN's `AppStateStatus`, narrowed to what this file distinguishes. */
export type AppStatus = 'active' | 'inactive' | 'background';

/**
 * The foreground signal (RN `AppState`), injected.
 *
 * `current()` exists so `start()` need not assume: an app resumed from the background may already
 * be `active` before anything subscribes, and a trigger set that waited for a *transition* would
 * never start its interval on that boot.
 */
export interface AppStatePort {
  current(): AppStatus;
  subscribe(listener: (status: AppStatus) => void): () => void;
}

/**
 * The connectivity signal (NetInfo), injected. Trigger (a) — see the header.
 *
 * `subscribe` matches `@react-native-community/netinfo`'s `addEventListener` contract EXACTLY (12.0.1
 * docs): the listener fires ONCE immediately with the current state, then again on every change, and
 * the return value unsubscribes. That "fires immediately" is load-bearing here — it is what turns a
 * boot that is already online into an initial sync, without a separate `current()` the adapter would
 * have to answer synchronously (NetInfo's own read is async). `connected` is `state.isConnected`.
 */
export interface NetInfoPort {
  subscribe(listener: (connected: boolean) => void): () => void;
}

export interface SyncTriggerDeps {
  /** `SyncLoop.requestSync` — fire-and-forget by contract; it never throws (api/01-sync §6). */
  readonly requestSync: (reason: SyncTriggerReason) => void;
  /** Core's one-shot timer seam (03 §10). Reused rather than re-declared (§2.8). */
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  /** Trigger (a): connectivity regained. `start()` subscribes; `stop()` unsubscribes. */
  readonly netInfo: NetInfoPort;
}

export interface SyncTriggers {
  /**
   * The append trigger (b), as core's `SyncSchedulerPort` (04 §5.1 step 7).
   *
   * The command runtime calls `schedule()` AFTER a command has already committed locally, so this
   * must never throw: a locally durable op is a successful command, and an offline device failing
   * commands for the crime of being offline is the exact opposite of the product (FR-1107/FR-1125).
   */
  readonly scheduler: SyncSchedulerPort;
  /** Begin (c): the 60 s foreground interval. Idempotent. */
  start(): void;
  /** Cancel every timer and unsubscribe. Idempotent. */
  stop(): void;
  /** (e) pull-to-refresh. The one reason that also breaks a running backoff early (03 §10). */
  requestManual(): void;
}

/**
 * Wire §5's buildable triggers onto a loop.
 *
 * The debounce COALESCES rather than queues: N appends inside 3 s produce ONE sync, because the
 * pending timer is cancelled and re-armed. That is the point of a debounce here — a bulk edit
 * emitting 40 ops must not schedule 40 cycles — and the loop's own rerun flag is the second line of
 * the same defence (03 §10: "a flag is not a counter").
 */
export function createSyncTriggers(deps: SyncTriggerDeps): SyncTriggers {
  let cancelDebounce: (() => void) | null = null;
  let cancelInterval: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeNet: (() => void) | null = null;
  /** Last connectivity reading, so a repeated `connected` is absorbed and only a REGAIN fires (a). */
  let lastConnected: boolean | null = null;
  let started = false;

  function onConnectivity(connected: boolean): void {
    const wasConnected = lastConnected;
    lastConnected = connected;
    // §5 (a) "connectivity regained": fire on a transition INTO connectivity. `null → true` is the
    // boot case (the app opened online) and DOES fire — the initial sync. `true → true` (a wifi
    // detail change) is absorbed, so the loop is not spun by NetInfo chatter. `→ false` never syncs.
    if (connected && wasConnected !== true) deps.requestSync('connectivity');
  }

  function armInterval(): void {
    if (cancelInterval !== null) return;
    // Re-arming one-shots rather than a real interval: `TimerPort` is core's one timer seam and a
    // second `setInterval`-shaped port would be a second answer to "how does this app wait" (§2.8).
    const tick = (): void => {
      cancelInterval = deps.timer.schedule(FOREGROUND_INTERVAL_MS, tick);
      // §5 (c) is "while online AND foregrounded". Foreground is checked here; "online" is NOT —
      // there is no connectivity signal (see (a) above), and the loop is the right place to find
      // out anyway. A wasted request on an offline device costs a failed fetch and a backoff tick;
      // suppressing the tick on a *guessed* offline state would cost a sync that should have run.
      if (deps.appState.current() === 'active') deps.requestSync('periodic');
    };
    cancelInterval = deps.timer.schedule(FOREGROUND_INTERVAL_MS, tick);
  }

  function disarmInterval(): void {
    cancelInterval?.();
    cancelInterval = null;
  }

  return {
    scheduler: {
      schedule(): void {
        cancelDebounce?.();
        cancelDebounce = deps.timer.schedule(APPEND_DEBOUNCE_MS, () => {
          cancelDebounce = null;
          deps.requestSync('append');
        });
      },
    },

    start(): void {
      if (started) return;
      started = true;
      unsubscribe = deps.appState.subscribe((status) => {
        if (status === 'active') armInterval();
        // Backgrounded: stop the interval. An interval that kept firing in the background would be
        // trigger (d) by accident — on a cadence the OS never agreed to, burning a metered
        // connection and a battery that 08 §2.2 budgets carefully.
        else disarmInterval();
      });
      // Trigger (a): subscribe connectivity. NetInfo fires the listener immediately with the current
      // state (12.0.1 contract), so an already-online boot syncs at once via `onConnectivity`.
      unsubscribeNet = deps.netInfo.subscribe(onConnectivity);
      // Do not wait for a transition: a boot that is already foregrounded (the normal case) would
      // otherwise never start its interval.
      if (deps.appState.current() === 'active') armInterval();
    },

    stop(): void {
      started = false;
      cancelDebounce?.();
      cancelDebounce = null;
      disarmInterval();
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeNet?.();
      unsubscribeNet = null;
      lastConnected = null;
    },

    requestManual(): void {
      deps.requestSync('manual');
    },
  };
}
