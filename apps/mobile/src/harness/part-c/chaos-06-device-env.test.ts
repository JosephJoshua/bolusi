// Node-side proof of the CHAOS-06 device runner's OWN two responsibilities (task 198). Like the CHAOS-03
// wrapper test, it deliberately does NOT stand up a server: apps/mobile carries no
// `@bolusi/harness`/`@bolusi/server` dependency by design (a token-minting server must not be able to
// bundle onto the device — a STRUCTURAL guarantee), so the real device→server round trip + the verdict
// flip on a re-insert are proven WHERE the server lives:
// packages/harness/scenarios/device-runner-chaos-06.test.ts (a real loopback socket to `@bolusi/server`,
// watched RED on the `reinsertOnReplay` control). This file proves the two things that are the mobile
// wrapper's own:
//   1. `gateFromVerdict` — the pure verdict→gate mapping, both branches, against synthetic verdicts.
//   2. `runChaos06Gate` catches a crash — a run that throws before a verdict is a RED naming the id
//      (§2.11), never a silent skip. A throwing DB driver rejects the run during device open, BEFORE any
//      network call, so this exercises the wrapper's catch without a server.
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Both guards were watched red before shipping:
//   • Make `gateFromVerdict` ignore `verdict.ok` and always `passed(...)` → the re-insert and
//     INCONCLUSIVE cases fail ("expected 'pass' to be 'fail'"). Restoring the `if (!verdict.ok)` returns
//     them to green — so a real re-insert verdict cannot map to a green gate.
//   • Delete the `try/catch` around `runChaos06` → the throwing-driver test no longer gets a `fail`
//     result; the rejection escapes `runChaos06Gate` and the test errors instead. Restoring the catch
//     turns the crash into the named RED. So the crash path is a real red, not an assumed one.
import { describe, expect, test } from 'vitest';

import type { Chaos06Net, Chaos06Verdict } from '@bolusi/test-support/chaos';

import { CHAOS06_GATE_ID, gateFromVerdict, runChaos06Gate } from './chaos-06-device-env.js';
import type { ChaosDbSeams } from './convergence-seams.js';

/** An idempotent run's verdict — the positive mapping control (unique metrics so the figures assertion
 *  is load-bearing, not a match on defaults). */
const OK_VERDICT: Chaos06Verdict = {
  ok: true,
  inconclusive: false,
  reason:
    'device A delivered 121 ops (all accepted), replayed 61 verbatim (all duplicate), a held-op pull applied 0, and a novel foreign op still applied — replay is idempotent.',
  metrics: { replayed: 61, duplicate: 61, heldPullApplied: 0, novelPullApplied: 2 },
};

/** A re-insert run: the server accepted a replayed op it should have deduped. `ok:false`, not
 *  inconclusive — a real idempotency failure. */
const REINSERT_VERDICT: Chaos06Verdict = {
  ok: false,
  inconclusive: false,
  reason:
    '61/61 replayed ops came back NOT `duplicate` — the server re-inserted ops it already held instead of deduping by id (05 §5).',
  metrics: { replayed: 61, duplicate: 0, heldPullApplied: 0, novelPullApplied: 2 },
};

/** A run whose premise never held: no clean first delivery. `ok:false` AND inconclusive — must NOT read
 *  as green. */
const INCONCLUSIVE_VERDICT: Chaos06Verdict = {
  ok: false,
  inconclusive: true,
  reason:
    'INCONCLUSIVE: no first delivery ran, so the server never returned a `duplicate` and a replay `accepted` cannot be read as a re-insert — nothing to witness (§2.11).',
  metrics: { replayed: 61, duplicate: 61, heldPullApplied: 0, novelPullApplied: 0 },
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

/** A net that must never be reached: the throwing driver rejects the run before any sync. Length 2 to
 *  match `CHAOS06_DEVICE_COUNT`, so the run passes the bearer-count check and throws at device open (a
 *  wrong length would throw the count error instead, defeating the crash test's premise). If `fetch` ever
 *  fires, the premise (throws before the network) is wrong and this surfaces it. */
const UNREACHED_NET: Chaos06Net = {
  fetch: () => {
    throw new Error('net.fetch must not be reached — the run should throw at device open');
  },
  auth: ['bdt_harness_unused_a', 'bdt_harness_unused_b'],
};

describe('CHAOS-06 device runner (mobile wrapper)', () => {
  test('gateFromVerdict maps an idempotent verdict to a PASS carrying the run metrics', () => {
    const gate = gateFromVerdict(OK_VERDICT);

    expect(gate.id).toBe(CHAOS06_GATE_ID);
    expect(gate.status).toBe('pass');
    expect(gate.detail).toBe(OK_VERDICT.reason);
    // Figures are regression-only (D12/D20) — mirror the verdict's metrics exactly.
    expect(gate.figures).toEqual({
      replayed: 61,
      duplicate: 61,
      heldPullApplied: 0,
      novelPullApplied: 2,
    });
  });

  test('gateFromVerdict maps a RE-INSERT verdict to a FAIL with the verdict reason', () => {
    const gate = gateFromVerdict(REINSERT_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(REINSERT_VERDICT.reason);
    expect(gate.figures).toBeUndefined(); // a red carries no figures
  });

  test('gateFromVerdict maps an INCONCLUSIVE verdict to a FAIL, never a silent green (§2.11)', () => {
    const gate = gateFromVerdict(INCONCLUSIVE_VERDICT);

    expect(gate.status).toBe('fail');
    expect(gate.detail).toBe(INCONCLUSIVE_VERDICT.reason);
  });

  test('runChaos06Gate turns a run that throws before a verdict into a named RED, not a gap', async () => {
    const gate = await runChaos06Gate(THROWING_SEAMS, UNREACHED_NET, { creates: 1, edits: 0 });

    expect(gate.id).toBe(CHAOS06_GATE_ID);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toMatch(/crash, not a gap/);
    // Attribution: the fail is the wrapper catching THIS driver throw, not a coincidental red.
    expect(gate.detail).toContain('op-sqlite unavailable in host test');
  });
});
