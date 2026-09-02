// Host proof of the CHAOS-01 device runner (task 181), as far as Node allows off the emulator.
//
// The convergence LOGIC (`VirtualDevice`, the canonical-fold oracle, `assertConvergence` /
// `assertBothFoldPaths`) is already Node-falsified in `@bolusi/test-support/chaos` and the harness
// scenario. What is NEW here is the DEVICE RUNNER `runChaos01Gate`: that it drives the shared rig through
// an injected DB seam and turns the outcome into an honest gate verdict. op-sqlite is a JSI module that
// cannot load under Node (testing-guide §2.3), so this binds the seam to better-sqlite3 (`:memory:`) —
// the identical `openClientDb`-shaped construction the runner uses on device — which lets vitest prove:
//   1. the real workload (shuffled arrival) makes the gate PASS, with BOTH §4.2 fold paths witnessed
//      (refolds > 0) — so a green can never mean "the run never re-folded" (§2.11 denominator);
//   2. a dropped op reds the gate via the convergence guard (`/convergence FAILED/`);
//   3. a no-contention run (`opsPerDevice: 0` → no device ever re-folds) reds the gate via the
//      both-fold-paths guard (`/INCONCLUSIVE/`) — refolds = 0 must NOT pass, even though every replica
//      then trivially converges (so ONLY guard #1 can catch it). Canonical DELIVERY is deliberately
//      NOT used here: each device applies its own offline ops before the cross-feed, so a
//      canonically-sorted feed still lands ops before already-applied ones and re-folds — it is a
//      convergence control, not a refolds=0 one.
// Controls 2 and 3 are driven THROUGH `runChaos01Gate`, so the reds are the RUNNER's, not just the raw
// assertions'. The only emulator-only residual is Hermes-vs-V8 engine behaviour.
import { describe, expect, test } from 'vitest';

import type { ConvergenceOptions } from '@bolusi/test-support/chaos';

import { openBetterSqlite3Driver } from '../../../test/better-sqlite3-driver.js';
import {
  CHAOS01_GATE_ID,
  DEFAULT_CHAOS01_OPTIONS,
  runChaos01Gate,
  type ChaosDbSeams,
} from './chaos-01-device-env.js';

/** The DB seam bound to Node: better-sqlite3 with `location: undefined` → a fresh independent `:memory:`
 * DB per `openDb` call, so the N device DBs + the reference DB never share state. `removeDb` is a no-op
 * (`:memory:` dies with its connection) — the same role op-sqlite + expo-file-system fill on device. */
function hostChaosSeams(): ChaosDbSeams {
  return {
    driverFactory: openBetterSqlite3Driver,
    location: undefined,
    removeDb: () => Promise.resolve(),
  };
}

describe('runChaos01Gate — the on-device CHAOS-01 convergence runner (task 181; Node leg)', () => {
  test('the real shuffled workload PASSES, with both §4.2 fold paths witnessed', async () => {
    const gate = await runChaos01Gate(hostChaosSeams());
    expect(gate.id).toBe(CHAOS01_GATE_ID);
    expect(gate.status, gate.detail).toBe('pass');
    // The denominator: a pass that never re-folded is inconclusive, so refolds MUST be > 0 here. This
    // also pins DEFAULT_CHAOS01_OPTIONS as large enough — if the default ever stopped exercising re-fold,
    // this assertion reds instead of a device run silently passing for the wrong reason.
    expect(gate.figures?.refolds ?? 0).toBeGreaterThan(0);
    expect(gate.figures?.headApplies ?? 0).toBeGreaterThan(0);
    expect(gate.figures?.devices).toBe(DEFAULT_CHAOS01_OPTIONS.deviceCount);
  }, 30_000);

  test('FALSIFICATION: a dropped op reds the gate via the convergence guard', async () => {
    const dropped: ConvergenceOptions = { ...DEFAULT_CHAOS01_OPTIONS, dropFromDevice0: 3 };
    const gate = await runChaos01Gate(hostChaosSeams(), dropped);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toMatch(/convergence FAILED/);
  }, 30_000);

  test('FALSIFICATION: a no-contention run reds the gate INCONCLUSIVE (refolds = 0 is not a pass)', async () => {
    // No offline authoring → the only ops are device 0's shared creates, which every device applies
    // in canonical order → refolds = 0 on every device. Convergence is trivially satisfied, so only
    // the both-fold-paths guard can catch it — and it must.
    const noContention: ConvergenceOptions = { ...DEFAULT_CHAOS01_OPTIONS, opsPerDevice: 0 };
    const gate = await runChaos01Gate(hostChaosSeams(), noContention);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toMatch(/INCONCLUSIVE/);
  }, 30_000);
});
