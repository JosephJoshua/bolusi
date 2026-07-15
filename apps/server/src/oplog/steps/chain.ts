// Chain-continuity classification (05 §4). Pure — the running chain head is threaded by the
// orchestrator (advanced only per accepted op). Distinguishes the three outcomes the rejection
// registry keeps separate (05 §8):
//   - CHAIN_GAP    — `seq` skips ahead of the head: a resend, the client re-pushes from the gap
//                    (NOT an error, no anomaly). Must be DISTINCT from CHAIN_BROKEN.
//   - CHAIN_BROKEN — `seq` is the expected next but `previousHash` ≠ the head's hash, OR `seq`
//                    is behind the head (a reorder/tamper). The batch remainder is HALTED.
//   - ok           — contiguous seq AND matching previousHash (genesis: 64 zeros).
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';
import type { SignedOperation } from '@bolusi/schemas';

/** The device's chain head as the orchestrator currently believes it. */
export interface ChainHead {
  readonly seq: number;
  readonly hash: string | null;
}

export type ChainOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'broken'; readonly reason: string };

export function classifyChain(op: SignedOperation, head: ChainHead): ChainOutcome {
  const expectedSeq = head.seq + 1;

  // Skip-ahead: the client thinks earlier ops were acked. Resend from the gap — not tamper.
  if (op.seq > expectedSeq) return { kind: 'gap' };

  // At or below a position we already hold (a true duplicate is caught earlier by id). A new op
  // at an old/equal seq is a reorder/injection.
  if (op.seq < expectedSeq) {
    return {
      kind: 'broken',
      reason: `seq ${op.seq} is behind the expected next seq ${expectedSeq}`,
    };
  }

  // Contiguous seq — the link must match. head.hash is null only at genesis (seq 1), where the
  // link must be 64 zeros (05 §2.1).
  const expectedPrevious = head.hash ?? GENESIS_PREVIOUS_HASH;
  if (op.previousHash !== expectedPrevious) {
    return {
      kind: 'broken',
      reason: `previousHash does not match the chain head at seq ${op.seq}`,
    };
  }

  return { kind: 'ok' };
}
