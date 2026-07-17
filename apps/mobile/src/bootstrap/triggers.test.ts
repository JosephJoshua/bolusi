// The platform sync triggers (api/01-sync §5) — (b) 3 s append debounce, (c) 60 s foreground
// interval, (e) manual. (a) NetInfo and (d) background task are NOT BUILT; see triggers.ts.
//
// Every timer is fake and every threshold is the EXPORTED constant, never a literal (T-6: a test
// that sleeps is a bug; a test with `3000` in it passes a change it should have caught).
import type { SyncTriggerReason } from '@bolusi/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  APPEND_DEBOUNCE_MS,
  createSyncTriggers,
  FOREGROUND_INTERVAL_MS,
  type AppStatus,
} from './triggers.js';

/** A `TimerPort` over vitest's fake timers — core's one timer seam, driven deterministically. */
const timer = {
  schedule: (delayMs: number, fn: () => void) => {
    const handle = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

function appState(initial: AppStatus = 'active') {
  let status = initial;
  const listeners = new Set<(s: AppStatus) => void>();
  return {
    port: {
      current: () => status,
      subscribe: (listener: (s: AppStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(next: AppStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** A fake `NetInfoPort`. Fires the listener ONCE immediately with the current state, then on every
 *  change — the `@react-native-community/netinfo` `addEventListener` contract the adapter relies on. */
function netInfo(initial = false) {
  let connected = initial;
  const listeners = new Set<(c: boolean) => void>();
  return {
    port: {
      subscribe: (listener: (c: boolean) => void) => {
        listeners.add(listener);
        listener(connected);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(next: boolean) {
      connected = next;
      for (const listener of listeners) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** Default OFFLINE so the (b)/(c)/(e) suites test their trigger in isolation — connectivity is (a)'s
 *  own suite. A boot that is offline never fires `connectivity`, so those assertions stay exact. */
function harness(initial: AppStatus = 'active', online = false) {
  const reasons: SyncTriggerReason[] = [];
  const state = appState(initial);
  const net = netInfo(online);
  const triggers = createSyncTriggers({
    requestSync: (reason) => reasons.push(reason),
    timer,
    appState: state.port,
    netInfo: net.port,
  });
  return { reasons, state, net, triggers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('(b) the append trigger — debounced 3 s (api/01-sync §5)', () => {
  test('one append fires ONE sync, after the debounce and not before', async () => {
    const h = harness();
    h.triggers.scheduler.schedule();

    await vi.advanceTimersByTimeAsync(APPEND_DEBOUNCE_MS - 1);
    expect(h.reasons).toStrictEqual([]); // not yet — a sync per keystroke is the bug

    await vi.advanceTimersByTimeAsync(1);
    expect(h.reasons).toStrictEqual(['append']);
  });

  test('N appends inside the window COALESCE into one sync — a debounce, not a queue', async () => {
    // A bulk edit emitting 40 ops must not schedule 40 cycles. The re-arm is what makes this true.
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      h.triggers.scheduler.schedule();
      await vi.advanceTimersByTimeAsync(APPEND_DEBOUNCE_MS / 2); // each lands inside the window
    }
    await vi.advanceTimersByTimeAsync(APPEND_DEBOUNCE_MS);

    expect(h.reasons).toStrictEqual(['append']);
  });

  test('appends in SEPARATE windows fire separately — the control against a debounce that never re-fires', async () => {
    // T-14b: without this, a `schedule()` that silently dropped everything after the first would
    // pass the coalescing test above.
    const h = harness();
    h.triggers.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(APPEND_DEBOUNCE_MS);
    h.triggers.scheduler.schedule();
    await vi.advanceTimersByTimeAsync(APPEND_DEBOUNCE_MS);

    expect(h.reasons).toStrictEqual(['append', 'append']);
  });

  test('schedule() never throws — a locally durable op is a successful command (04 §5.1 step 7)', () => {
    // The runtime calls this AFTER the commit. If it threw, an offline device would fail commands
    // for the crime of being offline (FR-1107/FR-1125) — the opposite of the product.
    const triggers = createSyncTriggers({
      requestSync: () => {
        throw new Error('loop exploded');
      },
      timer,
      appState: appState().port,
      netInfo: netInfo().port,
    });
    expect(() => triggers.scheduler.schedule()).not.toThrow();
  });
});

describe('(c) the foreground interval — 60 s while active (api/01-sync §5)', () => {
  test('ticks every 60 s while foregrounded', async () => {
    const h = harness('active');
    h.triggers.start();

    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 3);
    expect(h.reasons).toStrictEqual(['periodic', 'periodic', 'periodic']);
    h.triggers.stop();
  });

  test('a boot that is ALREADY active starts ticking — it does not wait for a transition', async () => {
    // The bug this prevents: subscribing only, and never seeing an `active` event because the app
    // was already active. The interval would never start and nothing would report it.
    const h = harness('active');
    h.triggers.start();

    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS);
    expect(h.reasons).toStrictEqual(['periodic']);
    h.triggers.stop();
  });

  test('backgrounding STOPS the interval — never trigger (d) by accident', async () => {
    // An interval that kept firing in the background would sync on a cadence the OS never agreed
    // to, burning a metered connection and a battery 08 §2.2 budgets carefully.
    const h = harness('active');
    h.triggers.start();
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS);
    expect(h.reasons).toStrictEqual(['periodic']);

    h.state.emit('background');
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 5);

    expect(h.reasons).toStrictEqual(['periodic']); // nothing more
    h.triggers.stop();
  });

  test('returning to the foreground RESUMES it — the control against a stop that is permanent', async () => {
    // T-14b again: a `start()` that could never resume would pass the test above and leave the app
    // never syncing after its first backgrounding.
    const h = harness('active');
    h.triggers.start();
    h.state.emit('background');
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 2);
    expect(h.reasons).toStrictEqual([]);

    h.state.emit('active');
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS);

    expect(h.reasons).toStrictEqual(['periodic']);
    h.triggers.stop();
  });

  test('a boot that starts BACKGROUNDED never ticks', async () => {
    const h = harness('background');
    h.triggers.start();

    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 3);
    expect(h.reasons).toStrictEqual([]);
    h.triggers.stop();
  });

  test('stop() cancels the interval AND unsubscribes — no leaked listener', async () => {
    const h = harness('active');
    h.triggers.start();
    expect(h.state.listenerCount).toBe(1);

    h.triggers.stop();
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 5);

    expect(h.reasons).toStrictEqual([]);
    expect(h.state.listenerCount).toBe(0);
  });

  test('start() is idempotent — a double start does not double the tick rate', async () => {
    const h = harness('active');
    h.triggers.start();
    h.triggers.start();

    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS);
    expect(h.reasons).toStrictEqual(['periodic']);
    h.triggers.stop();
  });
});

describe('(e) manual pull-to-refresh', () => {
  test('requestManual fires `manual` — the one reason that also breaks a backoff early (03 §10)', () => {
    const h = harness();
    h.triggers.requestManual();

    // The loop's `EARLY_EXIT_REASONS` is {manual, connectivity}; with (a) absent, `manual` is the
    // ONLY way a device inside a 5-minute backoff syncs before the timer expires. That is the
    // measured cost of (a)'s absence, and it is why the reason string matters here.
    expect(h.reasons).toStrictEqual(['manual']);
  });
});

describe('(a) connectivity — NetInfo listener (api/01-sync §5; task 89)', () => {
  test('an already-online boot syncs IMMEDIATELY — NetInfo fires on subscribe (the boot sync)', async () => {
    // The `null → connected` reading at start is a regain and kicks the initial sync, before any
    // interval tick. This is the line that makes "the loop starts on an enrolled device" true.
    const h = harness('active', true);
    h.triggers.start();
    expect(h.reasons).toStrictEqual(['connectivity']);
    h.triggers.stop();
  });

  test('regaining connectivity fires `connectivity` — the ONE reason that also breaks a backoff early (03 §10)', () => {
    // `EARLY_EXIT_REASONS` is {manual, connectivity}: with (a) wired, a device inside a 5-minute
    // backoff resumes the moment the network returns instead of waiting the timer out.
    const h = harness('active', false); // boots offline
    h.triggers.start();
    expect(h.reasons).toStrictEqual([]); // offline boot: nothing yet

    h.net.emit(true);
    expect(h.reasons).toStrictEqual(['connectivity']);
    h.triggers.stop();
  });

  test('a repeated connected reading is ABSORBED — NetInfo chatter must not spin the loop', () => {
    // wifi→wifi detail changes re-fire the listener with `connected: true`; only a transition INTO
    // connectivity is new information. Without this, every network blip would start a cycle.
    const h = harness('active', true);
    h.triggers.start(); // one boot sync
    h.net.emit(true);
    h.net.emit(true);
    expect(h.reasons).toStrictEqual(['connectivity']);
    h.triggers.stop();
  });

  test('losing connectivity NEVER syncs; a later regain fires again — the control against a latch', () => {
    // T-14b: a trigger that fired once and then latched would pass the tests above. Prove a second
    // genuine regain fires a second time, and that `→ false` is silent.
    const h = harness('active', false);
    h.triggers.start();
    h.net.emit(true); // regain #1
    h.net.emit(false); // lost — silent
    h.net.emit(true); // regain #2
    expect(h.reasons).toStrictEqual(['connectivity', 'connectivity']);
    h.triggers.stop();
  });

  test('stop() unsubscribes NetInfo — no leaked listener, no connectivity after stop', () => {
    const h = harness('active', false);
    h.triggers.start();
    expect(h.net.listenerCount).toBe(1);

    h.triggers.stop();
    expect(h.net.listenerCount).toBe(0);
    h.net.emit(true);
    expect(h.reasons).toStrictEqual([]);
  });
});

describe('(d) background task is ABSENT — stated, not faked', () => {
  test('no trigger set fires `background` — and the denominator now INCLUDES connectivity', async () => {
    // (a) landed (task 89), so this flipped: connectivity is now producible and IS asserted; only
    // (d) remains absent. If a later task wires the background task, this fails and must be updated —
    // the honest gap asserted rather than described in a comment nothing reads (§2.11).
    const h = harness('active', true);
    h.triggers.start();
    h.triggers.scheduler.schedule();
    h.triggers.requestManual();
    h.state.emit('background');
    h.state.emit('active');
    h.net.emit(false);
    h.net.emit(true);
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 5);
    h.triggers.stop();

    expect(h.reasons).not.toContain('background');
    // The denominator: the reasons this adapter CAN produce today — (a)/(b)/(c)/(e), not (d).
    expect([...new Set(h.reasons)].sort()).toStrictEqual([
      'append',
      'connectivity',
      'manual',
      'periodic',
    ]);
  });
});
