// Node-side proof of the CHAOS-07 device runner's OWN two responsibilities (task 198). Like the CHAOS-03
// and CHAOS-06 wrappers, it deliberately does NOT stand up a server: apps/mobile carries no
// `@bolusi/harness`/`@bolusi/server` dependency by design (a token-minting server must not be able to
// bundle onto the device — a STRUCTURAL guarantee). So the real device→server round trip, the
// converged-but-WRONG-winner RED, and the edit-after-archive surfacing are all proven WHERE the server +
// the system device + conflict detection live:
// packages/harness/scenarios/device-runner-chaos-07.test.ts (a real loopback socket to `@bolusi/server`
// with detection ON, watched RED on `reverseWinnerOracle` and INCONCLUSIVE with detection off). This file
// proves the two things that are the mobile wrapper's own:
//   1. `gateFromVerdict` — the pure verdict→gate mapping, both branches, against synthetic verdicts. The
//      task-198 Acceptance case "a converged-but-wrong winner is red" and the "(iii) never surfaced ⇒
//      INCONCLUSIVE, never pass" case both map through `ok:false`, so both must land as a RED here.
//   2. `runChaos07Gate` catches a crash — a run that throws before a verdict is a RED naming the id
//      (§2.11), never a silent skip. A throwing DB driver rejects the run at device open, BEFORE any
//      network call, so this exercises the wrapper's catch without a server.
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Both guards were watched red before shipping:
//   • Make `gateFromVerdict` ignore `verdict.ok` and always `passed(...)` → the wrong-winner and
//     INCONCLUSIVE cases fail ("expected 'pass' to be 'fail'"). Restoring the `if (!verdict.ok)` returns
//     them to green — so a real wrong-winner/inconclusive verdict cannot map to a green gate.
//   • Delete the `try/catch` around `runChaos07` → the throwing-driver test no longer gets a `fail`
//     result; the rejection escapes `runChaos07Gate` and the test errors instead. Restoring the catch
//     turns the crash into the named RED. So the crash path is a real red, not an assumed one.
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CHAOS07_OPTIONS,
  type Chaos07Net,
  type Chaos07Verdict,
} from '@bolusi/test-support/chaos';

import { CHAOS07_GATE_ID, gateFromVerdict, runChaos07Gate } from './chaos-07-device-env.js';
import type { ChaosDbSeams } from './convergence-seams.js';

/** A correct run's verdict — the positive mapping control. Unique metric values (converged 3, foreignApplied
 *  9, surfacedOnDevice 1) so the figures assertion is load-bearing, not a match on zeros/defaults. */
const OK_VERDICT: Chaos07Verdict = {
  ok: true,
  inconclusive: false,
  reason:
    '3/3 devices converged on the shared note; the LWW winner "body-207-C-1" is the canonical (timestamp,deviceId,seq) last edit; and edit-after-archive surfaced a significant conflict on device B — concurrent-edit resolution is correct.',
  metrics: { deviceCount: 3, converged: 3, foreignApplied: 9, surfacedOnDevice: 1 },
};

/** The task-198 Acceptance RED: the devices converged but on a body that is NOT the canonical LWW winner.
 *  `ok:false`, not inconclusive — a real conflict-resolution failure. */
const WRONG_WINNER_VERDICT: Chaos07Verdict = {
  ok: false,
  inconclusive: false,
  reason:
    'the devices converged but on the WRONG LWW winner: projection holds "body-207-A-1", canonical (timestamp,deviceId,seq) last edit is "body-207-C-1" (05 §4).',
  metrics: { deviceCount: 3, converged: 3, foreignApplied: 9, surfacedOnDevice: 1 },
};

/** The task-198 INCONCLUSIVE case: no `platform.conflict_detected` op reached B, so edit-after-archive
 *  never surfaced. `ok:false` AND inconclusive — must NOT read as green (§2.11). */
const INCONCLUSIVE_VERDICT: Chaos07Verdict = {
  ok: false,
  inconclusive: true,
  reason:
    'INCONCLUSIVE: no platform.conflict_detected op reached device B — edit-after-archive never surfaced, so (iii) proves nothing (§2.11 / task 198).',
  metrics: { deviceCount: 3, converged: 3, foreignApplied: 9, surfacedOnDevice: 0 },
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

/** A net that must never be reached: the throwing driver rejects the run before any sync. Length 3 to match
 *  `CHAOS07_DEVICE_COUNT`, so the run passes the bearer-count check and throws at device open (a wrong
 *  length would throw the count error instead, defeating the crash test's premise). If `fetch` ever fires,
 *  the premise (throws before the network) is wrong and this surfaces it. */
const UNREACHED_NET: Chaos07Net = {
  fetch: () => {
    throw new Error('net.fetch must not be reached — the run should throw at device open');
  },
  auth: ['bdt_harness_unused_a', 'bdt_harness_unused_b', 'bdt_harness_unused_c'],
};

describe('CHAOS-07 device runner (mobile wrapper)', () => {
  test('gateFromVerdict maps a correct verdict to a PASS carrying the run metrics', () => {
    const gate = gateFromVerdict(OK_VERDICT);

    expect(gate.id).toBe(CHAOS07_GATE_ID);
    expect(gate.status).toBe('pass');
    expect(gate.detail).toBe(OK_VERDICT.reason);
    // Figures are regression-only (D12/D20) — mirror the verdict's metrics exactly.
    expect(gate.figures).toEqual({
      deviceCount: 3,
      converged: 3,
      foreignApplied: 9,
      surfacedOnDevice: 1,
    });
  });

  test('gateFromVerdict maps a converged-but-WRONG-winner verdict to a FAIL with the verdict reason', () => {
    const gate = gateFromVerdict(WRONG_WINNER_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(WRONG_WINNER_VERDICT.reason);
    expect(gate.figures).toBeUndefined(); // a red carries no figures
  });

  test('gateFromVerdict maps an INCONCLUSIVE verdict to a FAIL, never a silent green (§2.11)', () => {
    const gate = gateFromVerdict(INCONCLUSIVE_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(INCONCLUSIVE_VERDICT.reason);
  });

  test('runChaos07Gate turns a run that throws before a verdict into a named RED, not a gap', async () => {
    const gate = await runChaos07Gate(THROWING_SEAMS, UNREACHED_NET, DEFAULT_CHAOS07_OPTIONS);

    expect(gate.id).toBe(CHAOS07_GATE_ID);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toMatch(/crash, not a gap/);
    // Attribution: the fail is the wrapper catching THIS driver throw, not a coincidental red.
    expect(gate.detail).toContain('op-sqlite unavailable in host test');
  });
});
