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
  type Chaos06Verdict,
} from '@bolusi/test-support/chaos';

import { type HarnessGateResult } from '../result.js';
import { gateFromChaosVerdict, runChaosNetGate } from './chaos-net-gate.js';
import { type ChaosDbSeams } from './convergence-seams.js';

/** The gate id this runner reports under — the CHAOS-06 slot in `EMULATOR_CORRECTNESS_GATE_IDS`. */
export const CHAOS06_GATE_ID = 'CHAOS-06';

/**
 * Map the shared verdict onto a gate result — delegates to the shared `gateFromChaosVerdict` (task 200) so
 * device and host agree by construction. `ok` is the only branch: a re-insert RED and an INCONCLUSIVE
 * run are BOTH `ok: false` in the rig, so both become a RED carrying the verdict's own reason (§2.11 —
 * an inconclusive run never reads as green). A pass carries the run's metrics as regression figures
 * (never an acceptance number, D12/D20).
 */
export function gateFromVerdict(verdict: Chaos06Verdict): HarnessGateResult {
  return gateFromChaosVerdict(CHAOS06_GATE_ID, verdict);
}

/**
 * Run the CHAOS-06 replay/idempotency workload over the injected `net` (a real device→host
 * `@bolusi/server` round trip) and return a real verdict (§2.11 — never a silent pass). The shared
 * `runChaosNetGate` builds the seams, runs the rig, maps the verdict, turns a pre-verdict throw into a
 * named RED, and tears the devices down in `finally`.
 */
export function runChaos06Gate(
  dbSeams: ChaosDbSeams,
  net: Chaos06Net,
  options: Chaos06Options = DEFAULT_CHAOS06_OPTIONS,
  seed: number = DEFAULT_CHAOS06_SEED,
): Promise<HarnessGateResult> {
  return runChaosNetGate(
    {
      gateId: CHAOS06_GATE_ID,
      seamsTag: 'chaos06',
      crashPhrase: 'replay run',
      run: runChaos06,
      evaluate: evaluateChaos06,
      gateFromVerdict,
    },
    dbSeams,
    net,
    options,
    seed,
  );
}
