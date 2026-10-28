// The shared trigger-loop lifecycle both the sync loop (`triggers.ts`, api/01-sync §5) and the media
// drain loop (`media/triggers.ts`, 06 §5.2) run on. It lives in its OWN module, NOT in the sync
// triggers file, on purpose: FR-1138 (media/sync-independence.test.ts) forbids a media source file
// importing the SYNC loop's scheduling, and the sync triggers file IS that scheduling. This module is
// neutral cadence infrastructure — a stateless factory each caller instantiates with its OWN state —
// so both loops build on it without the media loop reaching into the sync module (task 185 leg 1).
//
// Re-arming one-shots rather than a real interval: `TimerPort` is core's one timer seam and a second
// `setInterval`-shaped port would be a second answer to "how does this app wait" (§2.8). The debounce
// COALESCES rather than queues — a burst emitting 40 events must schedule ONE cycle, not 40 — and the
// consuming loop's own rerun/single-flight flag is the second line of the same defence (03 §10).
import type { TimerPort } from '@bolusi/core';

import type { AppStatePort, NetInfoPort } from './triggers.js';

/**
 * The ports + intervals a trigger loop runs on, plus the three actions that vary between the sync and
 * media loops. Everything else — the foreground-gated re-armed one-shot interval, the connectivity
 * REGAIN edge, the coalescing debounce, and the subscribe/unsubscribe lifecycle — is identical.
 */
export interface TriggerLoopDeps {
  /** Core's one-shot timer seam (03 §10). Reused rather than re-declared (§2.8). */
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  readonly netInfo: NetInfoPort;
  /** Foreground interval period (§5 (c) / §5.2 (c)). */
  readonly intervalMs: number;
  /** Debounce window for the coalescing per-event action (§5 (b) / §5.2 (b)). */
  readonly debounceMs: number;
  /** Fired on each foreground interval tick — the loop has ALREADY gated on `appState.current()==='active'`. */
  readonly onInterval: () => void;
  /**
   * Fired on a connectivity REGAIN: `null → true` (an already-online boot — the initial sync/drain)
   * or `false → true`. `true → true` (NetInfo wifi-detail chatter) is absorbed; `→ false` never fires.
   * A caller whose action can reject settles it itself — the loop never awaits (a trigger must not
   * block the event that fired it).
   */
  readonly onConnectivityRegain: () => void;
  /** Fired `debounceMs` after the LATEST `scheduleDebounced()` — N events in the window fire ONCE. */
  readonly onDebounced: () => void;
}

export interface TriggerLoop {
  /** The coalescing per-event action (b): re-arms a one-shot, so a burst produces one `onDebounced`. */
  scheduleDebounced(): void;
  /** Begin the foreground interval + connectivity subscription. Idempotent. */
  start(): void;
  /** Cancel every timer and unsubscribe. Idempotent. */
  stop(): void;
}

export function createTriggerLoop(deps: TriggerLoopDeps): TriggerLoop {
  let cancelDebounce: (() => void) | null = null;
  let cancelInterval: (() => void) | null = null;
  let unsubscribeApp: (() => void) | null = null;
  let unsubscribeNet: (() => void) | null = null;
  /** Last connectivity reading, so a repeated `connected` is absorbed and only a REGAIN fires (a). */
  let lastConnected: boolean | null = null;
  let started = false;

  function onConnectivity(connected: boolean): void {
    const wasConnected = lastConnected;
    lastConnected = connected;
    if (connected && wasConnected !== true) deps.onConnectivityRegain();
  }

  function armInterval(): void {
    if (cancelInterval !== null) return;
    const tick = (): void => {
      cancelInterval = deps.timer.schedule(deps.intervalMs, tick);
      // §5 (c) / §5.2 (c) is "while online AND foregrounded". Foreground is checked here; "online" is
      // NOT — a wasted request on an offline device costs a failed fetch and a backoff tick, while
      // suppressing on a *guessed* offline state would cost a cycle that should have run.
      if (deps.appState.current() === 'active') deps.onInterval();
    };
    cancelInterval = deps.timer.schedule(deps.intervalMs, tick);
  }

  function disarmInterval(): void {
    cancelInterval?.();
    cancelInterval = null;
  }

  return {
    scheduleDebounced(): void {
      cancelDebounce?.();
      cancelDebounce = deps.timer.schedule(deps.debounceMs, () => {
        cancelDebounce = null;
        deps.onDebounced();
      });
    },

    start(): void {
      if (started) return;
      started = true;
      unsubscribeApp = deps.appState.subscribe((status) => {
        if (status === 'active') armInterval();
        // Backgrounded: stop the interval. An interval that kept firing in the background would be
        // trigger (d) by accident — on a cadence the OS never agreed to, burning a metered
        // connection and a battery that 08 §2.2 budgets carefully.
        else disarmInterval();
      });
      // Trigger (a): subscribe connectivity. NetInfo fires the listener immediately with the current
      // state (12.0.1 contract), so an already-online boot fires at once via `onConnectivity`.
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
      unsubscribeApp?.();
      unsubscribeApp = null;
      unsubscribeNet?.();
      unsubscribeNet = null;
      lastConnected = null;
    },
  };
}
