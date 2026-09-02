// The multi-device convergence run now lives in the platform-free shared rig
// (@bolusi/test-support/chaos, task 181). This file is the NODE binding: `runConvergence` pre-binds
// `NODE_SEAMS` so every existing scenario keeps calling `runConvergence(seed, options)`.
import { runConvergence as sharedRunConvergence } from '@bolusi/test-support/chaos';
import type { ConvergenceOptions, ConvergenceResult } from '@bolusi/test-support/chaos';

import { NODE_SEAMS } from './seams-node.js';

export type { ConvergenceOptions, ConvergenceResult } from '@bolusi/test-support/chaos';

/** Run a full convergence scenario (§3.6), Node-bound to `NODE_SEAMS`. */
export function runConvergence(
  seed: number,
  options: ConvergenceOptions,
): Promise<ConvergenceResult> {
  return sharedRunConvergence(seed, options, NODE_SEAMS);
}
