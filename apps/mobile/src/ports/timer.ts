// The production `TimerPort` (03 §10 backoff; api/01-sync §5 debounce/interval) — the one place the
// app turns a delay into a real `setTimeout`.
//
// @bolusi/core owns no timers (08 §3.3 rule 3): the loop's backoff and the trigger adapters take a
// `TimerPort` so the whole schedule runs under a FAKE clock in tests (T-6: a test that sleeps is a
// bug). This file is the single real binding — `setTimeout`/`clearTimeout`, nothing more. It is
// Node-safe (both RN and Node provide them), so unlike op-sqlite/NetInfo it needs no injection gate;
// tests still pass their own fake rather than import this, so a real timer never reaches a test.
import type { CancelTimer, TimerPort } from '@bolusi/core';

/** `setTimeout`-backed one-shot timer. `schedule` returns a canceller; calling it twice is a no-op. */
export const systemTimer: TimerPort = {
  schedule(delayMs: number, fn: () => void): CancelTimer {
    const handle: ReturnType<typeof setTimeout> = setTimeout(fn, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};
