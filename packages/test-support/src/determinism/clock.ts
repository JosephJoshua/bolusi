// FakeClock — the injected `ClockPort` of the determinism kit (testing-guide §3.3, T-6).
//
// The command runtime, sync loop, lockout machine and staleness tiers all take time as an
// INPUT via `ClockPort` (04 §5.2 gives handlers no clock; the runtime stamps `timestamp`).
// A test/harness binds THIS in place of the system clock so every `timestamp` — and therefore
// canonical ordering — is a function of the seed alone (T-6). One instance per virtual device
// plus one for the server (§3.1); each is independently settable and skewable (CHAOS-04).
//
// `now()` is integer ms since the unix epoch, exactly like the production clock. The class
// rejects non-integer ms so a float can never leak into a `timestamp` and silently perturb
// ordering across engines.

import type { ClockPort } from '@bolusi/core';

function assertIntegerMs(ms: number, label: string): void {
  if (!Number.isInteger(ms)) {
    throw new RangeError(`FakeClock ${label} must be an integer ms epoch, got ${ms}`);
  }
}

/**
 * A deterministic, injectable clock. Satisfies core's `ClockPort`.
 *
 * - `advance(ms)` moves time FORWARD by `ms` (the normal per-op progression, §3.3). A negative
 *   advance is a bug and throws — time never runs backwards by accident.
 * - `set(ms)` jumps to an absolute epoch and MAY move backwards. Skew (CHAOS-04) and clock
 *   rollback (CHAOS-11) are expressed here, deliberately, so a rollback is an explicit act.
 */
export class FakeClock implements ClockPort {
  #ms: number;

  constructor(startMs = 0) {
    assertIntegerMs(startMs, 'start');
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  advance(ms: number): void {
    assertIntegerMs(ms, 'advance');
    if (ms < 0) {
      throw new RangeError(
        `FakeClock.advance moves time forward only; use set() to roll back (got ${ms})`,
      );
    }
    this.#ms += ms;
  }

  set(ms: number): void {
    assertIntegerMs(ms, 'set');
    this.#ms = ms;
  }
}
