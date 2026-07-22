/**
 * WHEN the idle check runs (api/02-auth §6.4) — the platform half of SEC-AUTH-08.
 *
 * ── THIS FILE DECIDES NOTHING ABOUT LOCKING ─────────────────────────────────────────────────────
 * The lock RULE lives in `SessionManager.checkIdle()` (@bolusi/core): the deadline is
 * `lastActivityAt + idleLockSeconds`, and only that function compares it to the clock. This file
 * owns one question — *how often does somebody ask?* — and nothing else. It cannot lock early, it
 * cannot lock late by more than one interval, and it cannot keep a session open: every tick is a
 * call into `checkIdle`, which answers "nothing was due" or emits `session_ended(idle_lock)`.
 *
 * That separation is deliberate. `@bolusi/core` owns no timers (08 §3.3 rule 3) precisely so the
 * TRANSITION is testable from a FakeClock without a sleeping test (T-6), which is why 14's class
 * shipped with the decision and no driver. This is the driver — and until task 133 it did not
 * exist, so the transition was reachable only from `shell-session.test.ts`.
 *
 * ── WHY THE APP-STATE SUBSCRIPTION IS PART OF THE CONTROL, NOT AN OPTIMISATION ───────────────────
 * A JS interval does not run reliably in the background — RN throttles it, and Android's Doze may
 * stop it entirely. A ticker that only counted intervals would therefore MISS the most likely real
 * lock: the phone put face-down on the counter for twenty minutes. So the transition INTO `active`
 * runs a tick immediately, before the interval re-arms. The elapsed time is read from the clock, not
 * accumulated by the timer, so a resume after any gap locks correctly on the first tick.
 *
 * Leaving `active` disarms the interval, for the reason `createSyncTriggers` disarms its own: a
 * timer the OS never agreed to is a battery cost with no counterpart benefit — nothing can be typed
 * into a backgrounded app, so nothing can go idle in a way a resume will not immediately notice.
 *
 * ── WHAT THIS DOES *NOT* GUARANTEE (say it here, not in a report nobody reads) ───────────────────
 * A locked screen is not a locked DEVICE. If the OS kills the process while backgrounded, this
 * ticker dies with it and the next launch is a cold boot — which reaches the switcher anyway
 * (`SessionManager.current` is in-memory and starts null), so the security outcome is the same by a
 * different route. What is genuinely NOT covered here, and cannot be from Node, is whether Android
 * delivers the `active` transition on every real resume path; that is device-suite territory
 * (D12/D13), and this file's honesty about it is the point.
 */
import type { TimerPort } from '@bolusi/core';

import type { AppStatePort } from '../bootstrap/triggers.js';

/**
 * How often the foregrounded app asks `checkIdle()`.
 *
 * NOT a lock rule and not a second deadline — see the header. It is the worst-case OVERSHOOT: a
 * session goes idle at `idleLockSeconds` and locks at most one interval later. 10 s is chosen
 * against §6.4's FLOOR rather than its default: a tenant on the minimum 60 s gets a ≤ 17 % overshoot
 * and one on the 300 s default ≤ 3 %, while the cost is one in-memory comparison per interval on a
 * foregrounded app (`checkIdle` touches no database and emits nothing until the deadline passes).
 */
export const IDLE_TICK_INTERVAL_MS = 10_000;

export interface IdleTickerDeps {
  /**
   * `ShellSession.tick` — one idle check. Resolves true iff THIS tick locked; the ticker ignores the
   * answer (it re-arms either way) and only exists to call it.
   */
  readonly tick: () => Promise<boolean>;
  /** Core's one-shot timer seam, re-armed rather than a second `setInterval`-shaped port (§2.8). */
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  /** Defaults to {@link IDLE_TICK_INTERVAL_MS}. Injected so a test drives the cadence, not the wall. */
  readonly intervalMs?: number;
  /**
   * Where a failed tick goes. A tick can only fail by failing to APPEND `session_ended` — i.e. the
   * op store rejected a write — and swallowing that silently would leave a session that believes it
   * locked and a log that never recorded it. Reported, never thrown: this runs from a timer
   * callback, where a rejection is an unhandled promise and takes the app down instead of the tick.
   */
  readonly onError?: (error: unknown) => void;
}

export interface IdleTicker {
  /** Subscribe + arm. Idempotent. */
  start(): void;
  /** Cancel the pending timer and unsubscribe. Idempotent. */
  stop(): void;
}

/**
 * Drive `tick` while the app is foregrounded, and once immediately on every resume.
 *
 * Modelled on `createSyncTriggers` (bootstrap/triggers.ts) on purpose: same `TimerPort`, same
 * `AppStatePort`, same re-armed one-shot, same "check `current()` at start rather than waiting for a
 * transition" rule — because a boot that is ALREADY foregrounded (the normal case) must arm.
 */
export function createIdleTicker(deps: IdleTickerDeps): IdleTicker {
  const intervalMs = deps.intervalMs ?? IDLE_TICK_INTERVAL_MS;
  let cancelInterval: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const runTick = (): void => {
    // Fire-and-forget with an explicit sink. `void` + `.catch` rather than `await`: the timer
    // callback is synchronous, and an unhandled rejection here would be a crash, not a missed lock.
    void deps.tick().catch((error: unknown) => deps.onError?.(error));
  };

  const armInterval = (): void => {
    if (cancelInterval !== null) return;
    const onInterval = (): void => {
      cancelInterval = deps.timer.schedule(intervalMs, onInterval);
      runTick();
    };
    cancelInterval = deps.timer.schedule(intervalMs, onInterval);
  };

  const disarmInterval = (): void => {
    cancelInterval?.();
    cancelInterval = null;
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      unsubscribe = deps.appState.subscribe((status) => {
        if (status !== 'active') {
          disarmInterval();
          return;
        }
        // RESUME. Check FIRST, then re-arm: the phone may have been face-down past the deadline,
        // and waiting a further interval to notice would hand the next person an open session.
        runTick();
        armInterval();
      });
      // No immediate tick here — at `start()` a session has just opened, so nothing can be due yet
      // and a tick would only be noise. The interval is what covers the foreground case.
      if (deps.appState.current() === 'active') armInterval();
    },

    stop(): void {
      started = false;
      disarmInterval();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
