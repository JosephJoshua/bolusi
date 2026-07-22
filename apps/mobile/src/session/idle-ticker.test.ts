// The idle ticker's own contract (api/02-auth §6.4; task 133) — the CADENCE, never the decision.
//
// The composed proof that this reaches a real device lives in `test/live-shell-idle-lock.test.tsx`,
// which mounts `Root` and locks a real session. What is proven HERE is the four properties that file
// exercises but does not isolate: the interval re-arms, a resume checks BEFORE re-arming, leaving the
// foreground disarms, and a failing tick is reported rather than thrown from a timer callback.
//
// Determinism (T-6): a hand-driven `TimerPort` and a hand-driven `AppStatePort`. No real timers.
import { beforeEach, describe, expect, test } from 'vitest';

import type { AppStatePort, AppStatus } from '../bootstrap/triggers.js';

import { createIdleTicker, IDLE_TICK_INTERVAL_MS } from './idle-ticker.js';

/** A `TimerPort` whose callbacks run only when the test says so. */
function manualTimer() {
  let nextId = 0;
  const scheduled = new Map<number, { readonly delayMs: number; readonly fn: () => void }>();
  return {
    port: {
      schedule(delayMs: number, fn: () => void) {
        const id = (nextId += 1);
        scheduled.set(id, { delayMs, fn });
        return () => {
          scheduled.delete(id);
        };
      },
    },
    pending: () => scheduled.size,
    delays: () => [...scheduled.values()].map((entry) => entry.delayMs),
    /** Run every callback pending right now (not the ones they re-arm). */
    fire(): number {
      const due = [...scheduled.entries()];
      for (const [id, entry] of due) {
        scheduled.delete(id);
        entry.fn();
      }
      return due.length;
    },
  };
}

function fakeAppState(initial: AppStatus = 'active') {
  let status = initial;
  const listeners = new Set<(next: AppStatus) => void>();
  const port: AppStatePort = {
    current: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    subscribers: () => listeners.size,
    set(next: AppStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

let timer: ReturnType<typeof manualTimer>;
let appState: ReturnType<typeof fakeAppState>;
let ticks: number;

beforeEach(() => {
  timer = manualTimer();
  appState = fakeAppState();
  ticks = 0;
});

function ticker(overrides: { readonly tick?: () => Promise<boolean> } = {}) {
  return createIdleTicker({
    tick:
      overrides.tick ??
      (() => {
        ticks += 1;
        return Promise.resolve(false);
      }),
    timer: timer.port,
    appState: appState.port,
  });
}

describe('the foreground interval (api/02-auth §6.4)', () => {
  test('a foregrounded start arms at IDLE_TICK_INTERVAL_MS and re-arms after every fire', () => {
    const idle = ticker();
    idle.start();

    // Armed WITHOUT waiting for a transition: an app that is already foregrounded at boot — the
    // normal case — would otherwise never tick at all.
    expect(timer.pending()).toBe(1);
    expect(timer.delays()).toEqual([IDLE_TICK_INTERVAL_MS]);
    expect(ticks).toBe(0); // nothing is due the instant a session opens

    timer.fire();
    expect(ticks).toBe(1);
    // Re-armed: a one-shot that did not re-arm would check exactly once and then never again — a
    // lock that fires only if the user happens to go idle in the first ten seconds.
    expect(timer.pending()).toBe(1);

    timer.fire();
    expect(ticks).toBe(2);
  });

  test('start is idempotent — a second call does not double the cadence', () => {
    const idle = ticker();
    idle.start();
    idle.start();
    expect(timer.pending()).toBe(1);
    expect(appState.subscribers()).toBe(1);
  });

  test('stop cancels the pending timer and unsubscribes; a fire after stop does nothing', () => {
    const idle = ticker();
    idle.start();
    idle.stop();

    expect(timer.pending()).toBe(0);
    expect(appState.subscribers()).toBe(0);
    expect(timer.fire()).toBe(0);
    expect(ticks).toBe(0);
  });
});

describe('app state (the resume path is part of the control, not an optimisation)', () => {
  test('leaving the foreground disarms — no timer the OS never agreed to', () => {
    const idle = ticker();
    idle.start();
    appState.set('background');

    expect(timer.pending()).toBe(0);
    expect(timer.fire()).toBe(0);
    expect(ticks).toBe(0);
  });

  test('a resume ticks IMMEDIATELY, then re-arms', () => {
    const idle = ticker();
    idle.start();
    appState.set('background');

    // The phone sat face-down past the deadline. The tick must not wait a further interval to
    // notice — that is a window in which the next person gets the previous user's session.
    appState.set('active');
    expect(ticks).toBe(1);
    expect(timer.pending()).toBe(1);
  });

  test('a boot that starts BACKGROUNDED arms nothing until it is foregrounded', () => {
    appState = fakeAppState('background');
    const idle = ticker();
    idle.start();

    expect(timer.pending()).toBe(0);
    expect(ticks).toBe(0);

    appState.set('active');
    expect(ticks).toBe(1);
    expect(timer.pending()).toBe(1);
  });
});

describe('a failing tick is reported, never thrown (it runs from a timer callback)', () => {
  test('the rejection reaches onError and the interval keeps running', async () => {
    const seen: unknown[] = [];
    const idle = createIdleTicker({
      tick: () => Promise.reject(new Error('append refused')),
      timer: timer.port,
      appState: appState.port,
      onError: (error) => seen.push(error),
    });
    idle.start();
    timer.fire();
    // The sink runs in the rejection's microtask, not synchronously with `fire`.
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('append refused');
    // A failed tick must not kill the cadence: the next append may well succeed, and a ticker that
    // stopped on the first error would disable the lock for the rest of the session.
    expect(timer.pending()).toBe(1);
  });
});
