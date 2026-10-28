// 06-media-pipeline §5.2's five triggers — four here, (d) in `background-task.test.ts`.
//
// Every assertion runs under a `FakeTimer` and a fake NetInfo, so nothing sleeps (T-6). What the
// suite is really guarding is the DIFFERENCE between the connectivity arm and the rest: (a) does
// not merely request a drain, it first CLEARS the backoff (03 §4.1), which is what makes a device
// that has been failing for five minutes resume the instant the network returns. Wiring (a) to
// `requestDrain('connectivity')` instead would compile, look right, and leave every failed upload
// waiting out a timer whose reason had gone.
import { describe, expect, test } from 'vitest';

import { FakeTimer, activeAppState, fakeNetInfo } from './_harness.test.js';
import { createMediaTriggers, type MediaTriggerDeps } from './triggers.js';

function rig(options: { online?: boolean; foreground?: boolean } = {}) {
  const drains: string[] = [];
  const connectivityResets: number[] = [];
  const errors: unknown[] = [];
  const timer = new FakeTimer();
  const net = fakeNetInfo(options.online ?? true);
  const appState =
    options.foreground === false
      ? { current: () => 'background' as const, subscribe: () => () => undefined }
      : activeAppState;

  const deps: MediaTriggerDeps = {
    requestDrain: (reason) => drains.push(reason),
    onConnectivityRegained: () => {
      connectivityResets.push(1);
      return Promise.resolve();
    },
    timer,
    appState,
    netInfo: net.port,
    onTriggerError: (error) => errors.push(error),
  };
  return { triggers: createMediaTriggers(deps), drains, connectivityResets, errors, timer, net };
}

describe('§5.2 (b) — debounced 3 s after any capture', () => {
  test('a capture schedules, and only the elapsed timer drains', () => {
    const { triggers, drains, timer } = rig();
    triggers.notifyCapture();
    // The trigger is a TIMER, not a call: nothing has drained yet.
    expect(drains).toEqual([]);
    timer.runPending();
    expect(drains).toEqual(['capture']);
  });

  test('a burst COALESCES into ONE pass', () => {
    // Ten photos of a damaged phone in twenty seconds is the normal case, not the unlucky one.
    const { triggers, drains, timer } = rig();
    for (let index = 0; index < 10; index += 1) triggers.notifyCapture();
    timer.runPending();
    expect(drains).toEqual(['capture']);
  });
});

describe('§5.2 (a) — connectivity regained', () => {
  test('an already-online boot fires the RESET, not a bare drain', () => {
    const { triggers, drains, connectivityResets } = rig({ online: true });
    triggers.start();
    // NetInfo fires immediately with the current state, so `null → true` is the boot case.
    expect(connectivityResets).toHaveLength(1);
    // And it is the reset path, which requests its own drain inside the loop — not this list.
    expect(drains).toEqual([]);
  });

  test('a REGAIN fires; repeated `connected` is absorbed; going offline never drains', () => {
    const { triggers, connectivityResets, net } = rig({ online: false });
    triggers.start();
    expect(connectivityResets).toHaveLength(0);

    net.emit(true);
    expect(connectivityResets).toHaveLength(1);
    // NetInfo chatter (a wifi detail change) must not spin the loop.
    net.emit(true);
    expect(connectivityResets).toHaveLength(1);

    net.emit(false);
    expect(connectivityResets).toHaveLength(1);
    net.emit(true);
    expect(connectivityResets).toHaveLength(2);
  });

  test('a REJECTING reset is surfaced, never a floating promise', () => {
    // The connectivity arm writes to the DB, so it can fail on a locked WAL. An unhandled rejection
    // in production is a crash on some runtimes and a silent loss on others.
    const errors: unknown[] = [];
    const triggers = createMediaTriggers({
      requestDrain: () => undefined,
      onConnectivityRegained: () => Promise.reject(new Error('db locked')),
      timer: new FakeTimer(),
      appState: activeAppState,
      netInfo: fakeNetInfo(true).port,
      onTriggerError: (error) => errors.push(error),
    });
    triggers.start();
    return Promise.resolve().then(() => {
      expect((errors[0] as Error).message).toBe('db locked');
    });
  });
});

describe('§5.2 (c) — periodic every 60 s while online AND foregrounded', () => {
  test('a foregrounded app arms the interval and each tick drains, re-arming itself', () => {
    const { triggers, drains, timer } = rig();
    triggers.start();
    timer.runPending(); // fires the connectivity-armed interval's first tick
    expect(drains).toContain('periodic');
    // Re-armed: a second elapse produces a second tick.
    timer.runPending();
    expect(drains.filter((reason) => reason === 'periodic')).toHaveLength(2);
  });

  test('a BACKGROUNDED app arms no interval — trigger (d) is not created by accident', () => {
    // An interval still firing in the background would be a cadence the OS never agreed to, on a
    // metered connection and a battery 08 §2.2 budgets carefully.
    const { triggers, drains, timer } = rig({ foreground: false });
    triggers.start();
    timer.runPending();
    expect(drains).not.toContain('periodic');
  });
});

describe('§5.2 (e) — manual retry, and teardown', () => {
  test('the sync-status retry button drains immediately, no debounce', () => {
    const { triggers, drains } = rig();
    triggers.requestManual();
    expect(drains).toEqual(['manual']);
  });

  test('`stop()` cancels every timer and unsubscribes — nothing fires afterwards', () => {
    const { triggers, drains, connectivityResets, timer, net } = rig();
    triggers.start();
    triggers.notifyCapture();
    triggers.stop();

    timer.runPending();
    net.emit(false);
    net.emit(true);

    expect(drains).toEqual([]);
    expect(connectivityResets).toHaveLength(1); // the one from `start()`, and no more
    expect(timer.pendingCount).toBe(0);
  });

  test('`start()` is idempotent — a second call does not double the interval', () => {
    const { triggers, timer } = rig();
    triggers.start();
    const armed = timer.pendingCount;
    triggers.start();
    expect(timer.pendingCount).toBe(armed);
  });
});
