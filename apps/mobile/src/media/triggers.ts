// The media drain triggers — 06-media-pipeline §5.2, the layer that turns device events into
// `MediaDrainLoop.requestDrain(reason)`.
//
// §5.2 says the set "mirrors the sync-loop triggers (api/01-sync §5), evaluated INDEPENDENTLY". The
// second word is the whole design and it is FR-1138 (06 §1: "a note/ticket is usable before its
// media has uploaded"): this file shares the sync triggers' PORTS — `AppStatePort`, `NetInfoPort`,
// `TimerPort`, one definition each, imported not restated (§2.8) — and shares none of their state.
// A stalled 3G media upload must never hold up an op push, and the only structural way to promise
// that is two independent trigger sets over two independent loops. Nothing below reads or awaits
// anything in `bootstrap/triggers.ts`.
//
// THE INTERVALS ARE THE SPEC'S, and they are the sync loop's numbers because §5.2 says "mirrors":
// 3 s debounce after a capture, 60 s periodic while online and foregrounded. They are imported from
// the sync trigger module rather than retyped, so a change to one cannot silently desynchronise the
// other pair — the mirror is by construction.
import type { MediaDrainTrigger, TimerPort } from '@bolusi/core';

import {
  APPEND_DEBOUNCE_MS,
  FOREGROUND_INTERVAL_MS,
  type AppStatePort,
  type NetInfoPort,
} from '../bootstrap/triggers.js';

export interface MediaTriggerDeps {
  /** `MediaDrainLoop.requestDrain` — fire-and-forget; it never throws (drain.ts). */
  readonly requestDrain: (reason: MediaDrainTrigger) => void;
  /**
   * `MediaDrainLoop.onConnectivityRegained` — 03 §4.1's reset. NOT the same as `requestDrain('connectivity')`:
   * it first CLEARS `nextAttemptAt` on every auto-retryable `failed` item, so a device that has been
   * backing off for five minutes resumes the moment the network returns rather than waiting out a
   * timer whose reason has gone. Returns a promise the loop settles on its own; this module never
   * awaits it (a trigger must not block the event that fired it).
   */
  readonly onConnectivityRegained: () => Promise<void>;
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  readonly netInfo: NetInfoPort;
  /**
   * Where an un-awaited trigger rejection goes. The connectivity arm writes to the DB
   * (`clearBackoffForRetry`), so it CAN reject — on a locked WAL, say — and a floating promise there
   * would be an unhandled rejection in production and a lint error here
   * (`@typescript-eslint/no-floating-promises` covers `apps/mobile/src`). Surfacing it beats both.
   */
  readonly onTriggerError: (error: unknown) => void;
}

export interface MediaTriggers {
  /** §5.2 (b): call after a capture commits. Debounced 3 s, coalescing. */
  notifyCapture(): void;
  /** Begin (a) + (c). Idempotent. */
  start(): void;
  /** Cancel every timer and unsubscribe. Idempotent. */
  stop(): void;
  /** §5.2 (e): the sync-status screen's retry button. */
  requestManual(): void;
}

/**
 * Wire §5.2's triggers onto a drain loop.
 *
 * FOUR of the five live here; (d) `expo-background-task` is in `background-task.ts` because it is a
 * process-global registration with a lifecycle of its own, and it calls `requestDrain('background_task')`
 * through the same loop. Stating that split here so a reader counting triggers in this file does
 * not conclude (d) is missing — the failure mode task 24's standard names, where absence reads as
 * an oversight instead of a decision.
 */
export function createMediaTriggers(deps: MediaTriggerDeps): MediaTriggers {
  let cancelDebounce: (() => void) | null = null;
  let cancelInterval: (() => void) | null = null;
  let unsubscribeApp: (() => void) | null = null;
  let unsubscribeNet: (() => void) | null = null;
  /** Last connectivity reading, so only a REGAIN fires (a) and NetInfo chatter is absorbed. */
  let lastConnected: boolean | null = null;
  let started = false;

  function onConnectivity(connected: boolean): void {
    const wasConnected = lastConnected;
    lastConnected = connected;
    // `null → true` is the boot case (the app opened online) and DOES fire — that is what drains a
    // queue left over from yesterday. `true → true` is absorbed; `→ false` never drains.
    if (connected && wasConnected !== true) {
      deps.onConnectivityRegained().catch(deps.onTriggerError);
    }
  }

  function armInterval(): void {
    if (cancelInterval !== null) return;
    const tick = (): void => {
      cancelInterval = deps.timer.schedule(FOREGROUND_INTERVAL_MS, tick);
      // §5.2 (c) is "while online AND foregrounded". Foreground is checked; "online" is not — a
      // wasted attempt on an offline device costs one failed fetch and a backoff tick, while
      // suppressing on a GUESSED offline state costs an upload that should have happened.
      if (deps.appState.current() === 'active') deps.requestDrain('periodic');
    };
    cancelInterval = deps.timer.schedule(FOREGROUND_INTERVAL_MS, tick);
  }

  function disarmInterval(): void {
    cancelInterval?.();
    cancelInterval = null;
  }

  return {
    notifyCapture(): void {
      // A debounce, not a queue: ten photos taken in a burst produce ONE drain pass, not ten. The
      // loop's own single-flight flag is the second line of the same defence (drain.ts).
      cancelDebounce?.();
      cancelDebounce = deps.timer.schedule(APPEND_DEBOUNCE_MS, () => {
        cancelDebounce = null;
        deps.requestDrain('capture');
      });
    },

    start(): void {
      if (started) return;
      started = true;
      unsubscribeApp = deps.appState.subscribe((status) => {
        if (status === 'active') armInterval();
        // Backgrounded: stop the interval. An interval still firing in the background would be
        // trigger (d) by accident, on a cadence the OS never agreed to, burning a metered
        // connection and a battery 08 §2.2 budgets carefully.
        else disarmInterval();
      });
      // NetInfo fires the listener IMMEDIATELY with the current state (12.0.1 contract), so an
      // already-online boot drains at once via `onConnectivity` — no separate boot trigger needed.
      unsubscribeNet = deps.netInfo.subscribe(onConnectivity);
      if (deps.appState.current() === 'active') armInterval();
    },

    stop(): void {
      started = false;
      cancelDebounce?.();
      cancelDebounce = null;
      disarmInterval();
      unsubscribeApp?.();
      unsubscribeApp = null;
      unsubscribeNet?.();
      unsubscribeNet = null;
      lastConnected = null;
    },

    requestManual(): void {
      deps.requestDrain('manual');
    },
  };
}
