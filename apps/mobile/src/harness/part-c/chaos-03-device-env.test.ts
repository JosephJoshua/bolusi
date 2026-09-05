// Node-side proof of the CHAOS-03 device runner's OWN two responsibilities (task 198). It deliberately
// does NOT stand up a server: apps/mobile carries no `@bolusi/harness`/`@bolusi/server` dependency by
// design (a token-minting server must not be able to bundle onto the device — a STRUCTURAL guarantee),
// so the real device→server round trip + the verdict flip on a lost op are proven WHERE the server lives:
// packages/harness/scenarios/chaos-03-device-runner.test.ts (a real loopback socket to `@bolusi/server`,
// watched RED on the drop control). This file proves the two things that are the mobile wrapper's own:
//   1. `gateFromVerdict` — the pure verdict→gate mapping, both branches, against synthetic verdicts.
//   2. `runChaos03Gate` catches a crash — a run that throws before a verdict is a RED naming the id
//      (§2.11), never a silent skip. A throwing DB driver rejects the run during device open, BEFORE any
//      network call, so this exercises the wrapper's catch without a server.
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Both guards were watched red before shipping:
//   • Make `gateFromVerdict` ignore `verdict.ok` and always `passed(...)` → the DIVERGENCE and
//     INCONCLUSIVE cases fail ("expected 'pass' to be 'fail'"). Restoring the `if (!verdict.ok)` returns
//     them to green — so a real lost-op verdict cannot map to a green gate.
//   • Delete the `try/catch` around `runChaos03` → the throwing-driver test no longer gets a `fail`
//     result; the rejection escapes `runChaos03Gate` and the test errors instead. Restoring the catch
//     turns the crash into the named RED. So the crash path is a real red, not an assumed one.
import { describe, expect, test } from 'vitest';

import type { Chaos03Net, Chaos03Verdict } from '@bolusi/test-support/chaos';

import { CHAOS03_GATE_ID, gateFromVerdict, runChaos03Gate } from './chaos-03-device-env.js';
import type { ChaosDbSeams } from './convergence-seams.js';

/** A converged run's verdict — the positive mapping control (unique metrics so the figures assertion is
 *  load-bearing, not a match on defaults). */
const OK_VERDICT: Chaos03Verdict = {
  ok: true,
  inconclusive: false,
  reason: '3 devices authored 120 ops offline and converged to the canonical fold over the wire.',
  metrics: { devices: 3, opsPerDevice: 120, foreignApplied: 240, converged: 3 },
};

/** A lost-op run: one device diverged from the fold. `ok:false`, not inconclusive — a real failure. */
const DIVERGED_VERDICT: Chaos03Verdict = {
  ok: false,
  inconclusive: false,
  reason: 'device-0 DIVERGED from the canonical fold — a foreign op did not survive the merge.',
  metrics: { devices: 3, opsPerDevice: 120, foreignApplied: 200, converged: 2 },
};

/** A run that never crossed the merge threshold: `ok:false` AND inconclusive — must NOT read as green. */
const INCONCLUSIVE_VERDICT: Chaos03Verdict = {
  ok: false,
  inconclusive: true,
  reason:
    'INCONCLUSIVE: device-1 had no foreign notes to fold — the merge never crossed the threshold.',
  metrics: { devices: 3, opsPerDevice: 120, foreignApplied: 0, converged: 3 },
};

/** A DB seam whose driver throws the moment the run opens a device — no op-sqlite off the emulator. The
 *  marker string lets the crash test prove it caught THIS throw, not a coincidental failure elsewhere. */
const THROWING_SEAMS: ChaosDbSeams = {
  driverFactory: () => {
    throw new Error('op-sqlite unavailable in host test');
  },
  location: undefined,
  removeDb: async () => {},
};

/** A net that must never be reached: the throwing driver rejects the run before any sync. If `fetch`
 *  ever fires, the crash test's premise (throws before the network) is wrong and this surfaces it. */
const UNREACHED_NET: Chaos03Net = {
  fetch: () => {
    throw new Error('net.fetch must not be reached — the run should throw at device open');
  },
  auth: ['bdt_harness_unused'],
};

describe('CHAOS-03 device runner (mobile wrapper)', () => {
  test('gateFromVerdict maps a converged verdict to a PASS carrying the run metrics', () => {
    const gate = gateFromVerdict(OK_VERDICT);

    expect(gate.id).toBe(CHAOS03_GATE_ID);
    expect(gate.status).toBe('pass');
    expect(gate.detail).toBe(OK_VERDICT.reason);
    // Figures are regression-only (D12/D20) — mirror the verdict's metrics exactly.
    expect(gate.figures).toEqual({
      devices: 3,
      opsPerDevice: 120,
      foreignApplied: 240,
      converged: 3,
    });
  });

  test('gateFromVerdict maps a DIVERGENCE verdict to a FAIL with the verdict reason', () => {
    const gate = gateFromVerdict(DIVERGED_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(DIVERGED_VERDICT.reason);
    expect(gate.figures).toBeUndefined(); // a red carries no figures
  });

  test('gateFromVerdict maps an INCONCLUSIVE verdict to a FAIL, never a silent green (§2.11)', () => {
    const gate = gateFromVerdict(INCONCLUSIVE_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(INCONCLUSIVE_VERDICT.reason);
  });

  test('runChaos03Gate turns a run that throws before a verdict into a named RED, not a gap', async () => {
    const gate = await runChaos03Gate(THROWING_SEAMS, UNREACHED_NET, {
      deviceCount: 1,
      opsPerDevice: 1,
      sharedNotes: 0,
    });

    expect(gate.id).toBe(CHAOS03_GATE_ID);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toMatch(/crash, not a gap/);
    // Attribution: the fail is the wrapper catching THIS driver throw, not a coincidental red.
    expect(gate.detail).toContain('op-sqlite unavailable in host test');
  });
});
