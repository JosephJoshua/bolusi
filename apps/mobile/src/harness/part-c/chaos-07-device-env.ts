// CHAOS-07's on-device runner (task 198): concurrent same-note edits + edit-after-archive (§3.6, 01
// §8.2) folded through the REAL `@bolusi/core` engine on the device's Hermes runtime, over op-sqlite —
// and, like CHAOS-03/06, driving a REAL `@bolusi/server` over the wire through the production push+pull
// phases. The device pulls EVERY op it did not author — member edits AND the system's server-minted
// `platform.conflict_detected` — through the real verify-and-quarantine pull path, so a green here means
// the device converges on the canonical LWW winner AND surfaces an edit-after-archive conflict from a
// system-signed op it verified over the network (not one hand-fed past the signature check).
//
// ── ONE RIG, TWO BINDINGS (§2.8), extended to the server seam ─────────────────────────────────────
// The workload + verdict body — `runChaos07`/`evaluateChaos07` — lives in the platform-free shared rig
// `@bolusi/test-support/chaos` (bundle-safe; chaos-bundle-safe.test.ts guards it, incl. the added
// `@bolusi/core` platform imports the rig folds through — `platform` already ships on device via
// `ALL_MODULES`). THIS file is the device binding of TWO seams:
//   • DB engine — the op-sqlite `ChaosDbSeams` run-and-emit.ts injects, turned into a `ConvergenceSeams`
//                 by the SHARED `buildConvergenceSeams` (./convergence-seams.js). The rig adds the
//                 `platform` module per-run (extraModules) so the device folds the conflict op.
//   • server   — `Chaos07Net` (a `FetchLike` + one bearer per device in `mintIdentities` order),
//                injected exactly as the DB engine is. On device it is the RN global `fetch` over
//                `10.0.2.2` / `adb reverse` to the laptop harness (§2.6); run-and-emit.ts binds it.
// Neither the rig nor this file re-implements the fold, the transport, the conflict detector, or the
// verdict (T-7). The system device + its signing key + detection-ON are HOST-side setup the host proof
// does before calling the rig; on device the emulator harness stands up the same server the same way.
//
// ── WHAT PROVES THIS RUNNER, AND WHERE (§2.11 — no false "full integration" claim) ─────────────────
// The real device→server round trip + BOTH watched-RED controls (a wrong LWW winner; an
// edit-after-archive that never surfaces) are proven over a REAL loopback socket to the production
// `@bolusi/server` with conflict detection ON in packages/harness/scenarios/device-runner-chaos-07.test.ts
// (the host binding: NODE_SEAMS + socketBaseFetch + a seeded system device). This file's OWN tests do NOT
// stand up a server — apps/mobile carries no `@bolusi/harness`/`@bolusi/server` dependency by design (a
// token-minting server must not be able to bundle onto the device — a STRUCTURAL guarantee, not a
// convention). So the mobile side proves the two things that are its OWN: the pure verdict→gate mapping
// (`gateFromVerdict`, both branches, against synthetic verdicts) and the crash guard (a runner that throws
// before a verdict is a RED naming the id, never a silent skip). The happy composition (run → evaluate →
// map) is the straight-line glue the socket test already exercises end to end.
import {
  evaluateChaos07,
  runChaos07,
  DEFAULT_CHAOS07_OPTIONS,
  DEFAULT_CHAOS07_SEED,
  type Chaos07Net,
  type Chaos07Options,
  type Chaos07Verdict,
} from '@bolusi/test-support/chaos';

import { type HarnessGateResult } from '../result.js';
import { gateFromChaosVerdict, runChaosNetGate } from './chaos-net-gate.js';
import { type ChaosDbSeams } from './convergence-seams.js';

/** The gate id this runner reports under — the CHAOS-07 slot in `EMULATOR_CORRECTNESS_GATE_IDS`. */
export const CHAOS07_GATE_ID = 'CHAOS-07';

/**
 * Map the shared verdict onto a gate result — delegates to the shared `gateFromChaosVerdict` (task 200) so
 * device and host agree by construction. `ok` is the only branch: a wrong-winner RED, a
 * detected-but-not-surfaced RED, and an INCONCLUSIVE run (dead pull path, or (iii) never surfaced) are ALL
 * `ok: false` in the rig, so all become a RED carrying the verdict's own reason (§2.11 — an inconclusive
 * run never reads as green). A pass carries the run's metrics as regression figures (never an acceptance
 * number, D12/D20).
 */
export function gateFromVerdict(verdict: Chaos07Verdict): HarnessGateResult {
  return gateFromChaosVerdict(CHAOS07_GATE_ID, verdict);
}

/**
 * Run the CHAOS-07 concurrent-edit / edit-after-archive workload over the injected `net` (a real device→
 * host `@bolusi/server` round trip, detection ON) and return a real verdict (§2.11 — never a silent pass).
 * The shared `runChaosNetGate` builds the seams, runs the rig, maps the verdict, turns a pre-verdict throw
 * into a named RED, and tears the devices down in `finally`.
 */
export function runChaos07Gate(
  dbSeams: ChaosDbSeams,
  net: Chaos07Net,
  options: Chaos07Options = DEFAULT_CHAOS07_OPTIONS,
  seed: number = DEFAULT_CHAOS07_SEED,
): Promise<HarnessGateResult> {
  return runChaosNetGate(
    {
      gateId: CHAOS07_GATE_ID,
      seamsTag: 'chaos07',
      crashPhrase: 'conflict run',
      run: runChaos07,
      evaluate: evaluateChaos07,
      gateFromVerdict,
    },
    dbSeams,
    net,
    options,
    seed,
  );
}
