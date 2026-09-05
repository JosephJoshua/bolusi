// CHAOS-06's on-device runner (task 198): the replay / idempotency workload (§3.6, 05 §5) folded
// through the REAL `@bolusi/core` engine on the device's Hermes runtime, over op-sqlite — and, like
// CHAOS-03, driving a REAL `@bolusi/server` over the wire through the production push+pull phases. This
// is the dual of CHAOS-03: not "do offline authors converge?" but "does re-delivering ops the server
// already holds change anything?" — which must be NO (the server dedups by op id).
//
// ── ONE RIG, TWO BINDINGS (§2.8), extended to the server seam ─────────────────────────────────────
// The replay + verdict body — `runChaos06`/`evaluateChaos06` — lives in the platform-free shared rig
// `@bolusi/test-support/chaos` (bundle-safe; chaos-bundle-safe.test.ts guards it). THIS file is the
// device binding of TWO seams:
//   • DB engine — the op-sqlite `ChaosDbSeams` run-and-emit.ts injects, turned into a `ConvergenceSeams`
//                 by the SHARED `buildConvergenceSeams` (./convergence-seams.js — the same builder
//                 CHAOS-01/03 use, so the bare-client-DB construction lives once, §2.8).
//   • server   — `Chaos06Net` (a `FetchLike` + one bearer per device in `mintIdentities` order),
//                injected exactly as the DB engine is. On device it is the RN global `fetch` over
//                `10.0.2.2` / `adb reverse` to the laptop harness (§2.6); run-and-emit.ts binds it.
// Neither the rig nor this file re-implements the fold, the transport, or the verdict (T-7).
//
// ── WHAT PROVES THIS RUNNER, AND WHERE (§2.11 — no false "full integration" claim) ─────────────────
// The real device→server round trip + the verdict flip on a re-insert are proven over a REAL loopback
// socket to the production `@bolusi/server` in packages/harness/scenarios/device-runner-chaos-06.test.ts
// (the host binding: NODE_SEAMS + socketBaseFetch, watched RED on the `reinsertOnReplay` control,
// INCONCLUSIVE on `skipFirstDelivery`). This file's OWN tests do NOT stand up a server — apps/mobile
// carries no `@bolusi/harness`/`@bolusi/server` dependency by design (a token-minting server must not be
// able to bundle onto the device — a STRUCTURAL guarantee, not a convention). So the mobile side proves
// the two things that are its OWN: the pure verdict→gate mapping (`gateFromVerdict`, both branches,
// against synthetic verdicts) and the crash guard (a runner that throws before a verdict is a RED naming
// the id, never a silent skip). The happy composition (run → evaluate → map) is the straight-line glue
// the socket test already exercises end to end.
import {
  evaluateChaos06,
  runChaos06,
  DEFAULT_CHAOS06_OPTIONS,
  DEFAULT_CHAOS06_SEED,
  type Chaos06Net,
  type Chaos06Options,
  type Chaos06Result,
  type Chaos06Verdict,
} from '@bolusi/test-support/chaos';

import { describeError, failed, passed, type HarnessGateResult } from '../result.js';
import { buildConvergenceSeams, type ChaosDbSeams } from './convergence-seams.js';

/** The gate id this runner reports under — the CHAOS-06 slot in `EMULATOR_CORRECTNESS_GATE_IDS`. */
export const CHAOS06_GATE_ID = 'CHAOS-06';

/**
 * Map the shared verdict onto a gate result — the ONE place the CHAOS-06 verdict becomes pass/fail, so
 * device and host agree by construction. `ok` is the only branch: a re-insert RED and an INCONCLUSIVE
 * run are BOTH `ok: false` in the rig, so both become a RED carrying the verdict's own reason (§2.11 —
 * an inconclusive run never reads as green). A pass carries the run's metrics as regression figures
 * (never an acceptance number, D12/D20).
 */
export function gateFromVerdict(verdict: Chaos06Verdict): HarnessGateResult {
  if (!verdict.ok) return failed(CHAOS06_GATE_ID, verdict.reason);
  return passed(CHAOS06_GATE_ID, verdict.reason, {
    replayed: verdict.metrics.replayed,
    duplicate: verdict.metrics.duplicate,
    heldPullApplied: verdict.metrics.heldPullApplied,
    novelPullApplied: verdict.metrics.novelPullApplied,
  });
}

/**
 * Run the CHAOS-06 replay/idempotency workload over the injected `net` (a real device→host
 * `@bolusi/server` round trip) and return a real verdict (§2.11 — never a silent pass). A throw from the
 * run itself — before any verdict exists — becomes a RED naming the crash, never a gap; the run's
 * devices are always torn down in `finally`.
 */
export async function runChaos06Gate(
  dbSeams: ChaosDbSeams,
  net: Chaos06Net,
  options: Chaos06Options = DEFAULT_CHAOS06_OPTIONS,
  seed: number = DEFAULT_CHAOS06_SEED,
): Promise<HarnessGateResult> {
  const seams = buildConvergenceSeams(dbSeams, 'chaos06');

  let result: Chaos06Result;
  try {
    result = await runChaos06(seed, options, seams, net);
  } catch (error) {
    return failed(
      CHAOS06_GATE_ID,
      `CHAOS-06 replay run threw before producing a verdict — a crash, not a gap (§2.11): ${describeError(error)}`,
    );
  }

  try {
    return gateFromVerdict(evaluateChaos06(result));
  } finally {
    await result.close();
  }
}
