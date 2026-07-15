// The device `ClockPort` (08 §3.2). The ONLY place `Date.now()` is read in this app.
//
// It exists so that everything above it — the command runtime, the lockout machine, the idle timer,
// the staleness tiers — takes time as an INPUT rather than reading the wall clock. That is what makes
// them testable from a FakeClock (T-6), and it is why `bolusi/no-clock-in-handlers` can be a lint
// rule at all: there is exactly one legitimate caller of the system clock, and this is it.
//
// The clock is NOT trusted for security decisions. A device clock is user-settable, and two places
// depend on that being harmless: the PIN lockout window (`notBefore` is a stored epoch that is never
// recomputed downward — SEC-AUTH-04) and staleness (measured from the server-relative baseline, not
// from this clock — 03 §8). Both treat this port as "roughly now", never as truth.
import type { ClockPort } from '@bolusi/core';

export const systemClock: ClockPort = {
  now(): number {
    return Date.now();
  },
};
