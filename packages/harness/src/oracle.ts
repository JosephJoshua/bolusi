// The convergence oracle now lives in the platform-free shared rig (@bolusi/test-support/chaos,
// task 181). This file is the NODE binding: `canonicalFold` pre-binds `NODE_SEAMS`; the assertions
// (`assertConvergence`, `assertBothFoldPaths`, `notesRows`) are pure and re-exported unchanged.
import type { SignedOperation } from '@bolusi/schemas';
import { canonicalFold as sharedCanonicalFold, type NotesRow } from '@bolusi/test-support/chaos';

import { NODE_SEAMS } from './seams-node.js';

export {
  assertConvergence,
  assertBothFoldPaths,
  notesRows,
  type NotesRow,
  type Replica,
} from '@bolusi/test-support/chaos';

/** The canonical-fold reference for an op set (§3.4), Node-bound to `NODE_SEAMS`. */
export function canonicalFold(
  ops: readonly SignedOperation[],
): Promise<{ digest: string; rows: NotesRow[] }> {
  return sharedCanonicalFold(ops, NODE_SEAMS);
}
