// The ONE parameterised device→server chaos gate the CHAOS-03/06/07 mobile wrappers share (task 200).
// Those three runners are the SAME shape: build the convergence seams from the op-sqlite `ChaosDbSeams`,
// run the shared rig over an injected `net` (a real device→host `@bolusi/server` round trip), map the
// verdict onto a gate result, and tear the devices down in `finally`. The per-scenario files
// (chaos-0{3,6,7}-device-env.ts) used to each carry a byte-identical copy of that body; it now lives here
// once, and each file is a thin wrapper that names its gate id, seams prefix, crash phrase, and the
// rig's `runChaosNN`/`evaluateChaosNN` (§2.8 — one rig, two bindings; this is the shared glue, not a
// second binding).
//
// STAYS OFF THE DEVICE-SERVER COUPLING BOUNDARY. This file imports only the rig's TYPES from
// `@bolusi/test-support/chaos` (erased at build) plus `../result.js` and `./convergence-seams.js` — the
// exact import surface the three wrappers already had. apps/mobile gains NO `@bolusi/harness`/
// `@bolusi/server` dependency: a token-minting server must not be able to bundle onto the device (a
// STRUCTURAL guarantee, not a convention).
import { describeError, failed, passed, type HarnessGateResult } from '../result.js';
import { buildConvergenceSeams, type ChaosDbSeams } from './convergence-seams.js';

import type { ConvergenceSeams } from '@bolusi/test-support/chaos';

/** The verdict shape the mapper reads — the common subset of every `ChaosNNVerdict`. `metrics` carries the
 *  run's regression figures (never an acceptance number, D12/D20); `inconclusive` is deliberately absent
 *  because it is already folded into `ok: false` at the rig (an inconclusive run never reads as green). */
export interface ChaosNetVerdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly metrics: Readonly<Record<string, number>>;
}

/** The minimal run handle the runner needs to guarantee teardown. Every `ChaosNNResult` satisfies it. */
export interface ChaosNetResult {
  close(): Promise<void>;
}

/**
 * The knobs that differ between the three otherwise-identical device→server chaos runners. `run` and
 * `evaluate` are the rig's own `runChaosNN`/`evaluateChaosNN`; an `evaluate` that ignores `options`
 * (CHAOS-06/07) still satisfies the two-arg field by parameter bivariance. `gateFromVerdict` is the
 * scenario's own verdict→gate mapper (each delegates to `gateFromChaosVerdict` with its gate id), injected
 * so the run's mapping stays the per-file symbol the wrapper tests drive; `gateId` is still needed on its
 * own for the crash RED, which fires BEFORE any verdict exists to map.
 */
export interface ChaosNetGateSpec<OptionsT, NetT, ResultT extends ChaosNetResult, VerdictT> {
  /** The gate id this runner reports under (e.g. `CHAOS-03`) — used for the pre-verdict crash RED. */
  readonly gateId: string;
  /** The DB-name prefix handed to `buildConvergenceSeams` (e.g. `chaos03`). */
  readonly seamsTag: string;
  /** Names the workload in the crash RED — e.g. `days-offline merge run` → `${gateId} ${phrase} threw …`. */
  readonly crashPhrase: string;
  run(seed: number, options: OptionsT, seams: ConvergenceSeams, net: NetT): Promise<ResultT>;
  evaluate(result: ResultT, options: OptionsT): VerdictT;
  gateFromVerdict(verdict: VerdictT): HarnessGateResult;
}

/**
 * Map a shared verdict onto a gate result — the ONE place a device→server chaos verdict becomes pass/fail,
 * so device and host agree by construction. `ok` is the only branch: a DIVERGENCE/RE-INSERT/wrong-winner
 * RED and an INCONCLUSIVE run are ALL `ok: false` in the rig, so all become a RED carrying the verdict's
 * own reason (§2.11 — an inconclusive run never reads as green). A pass carries the run's metrics as
 * regression figures (never an acceptance number, D12/D20).
 */
export function gateFromChaosVerdict(gateId: string, verdict: ChaosNetVerdict): HarnessGateResult {
  if (!verdict.ok) return failed(gateId, verdict.reason);
  return passed(gateId, verdict.reason, { ...verdict.metrics });
}

/**
 * Run one device→server chaos workload over the injected `net` (a real device→host `@bolusi/server` round
 * trip) and return a real verdict (§2.11 — never a silent pass). A throw from the run itself — before any
 * verdict exists — becomes a RED naming the crash, never a gap; the run's devices are always torn down in
 * `finally`.
 */
export async function runChaosNetGate<OptionsT, NetT, ResultT extends ChaosNetResult, VerdictT>(
  spec: ChaosNetGateSpec<OptionsT, NetT, ResultT, VerdictT>,
  dbSeams: ChaosDbSeams,
  net: NetT,
  options: OptionsT,
  seed: number,
): Promise<HarnessGateResult> {
  const seams = buildConvergenceSeams(dbSeams, spec.seamsTag);

  let result: ResultT;
  try {
    result = await spec.run(seed, options, seams, net);
  } catch (error) {
    return failed(
      spec.gateId,
      `${spec.gateId} ${spec.crashPhrase} threw before producing a verdict — a crash, not a gap (§2.11): ${describeError(error)}`,
    );
  }

  try {
    return spec.gateFromVerdict(spec.evaluate(result, options));
  } finally {
    await result.close();
  }
}
