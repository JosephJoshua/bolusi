// Idempotent replay: dedupe by op `id` (05 §5). A replayed already-accepted op returns `duplicate`,
// consumes no serverSeq, inserts nothing, records no anomaly; a replayed refused op gets its stored
// answer. Both are read ONCE per push batch for every op id in it, not per op. The reads are
// RLS-scoped (tenant-bound handle), served by the operations PK and refused_operations' key.
import type { TenantDb } from '@bolusi/db-server';
import type { RejectionCode } from '@bolusi/schemas';

export interface StoredRefusal {
  readonly hash: string;
  readonly code: RejectionCode;
  readonly reason: string;
}

/** What the server already decided about a push batch's op ids, kept current as the batch runs. */
export interface BatchVerdicts {
  /** Op ids already in this tenant's log. */
  readonly accepted: Set<string>;
  /** The pushing device's earlier refusals, by op id. */
  readonly refused: Map<string, StoredRefusal>;
}

export async function loadBatchVerdicts(
  db: TenantDb,
  deviceId: string,
  opIds: readonly string[],
): Promise<BatchVerdicts> {
  if (opIds.length === 0) return { accepted: new Set(), refused: new Map() };
  // Sequential: both run on the one transaction connection.
  const accepted = await db
    .selectFrom('operations')
    .select('id')
    .where('id', 'in', opIds)
    .execute();
  const refused = await db
    .selectFrom('refusedOperations')
    .select(['id', 'hash', 'code', 'reason'])
    .where('id', 'in', opIds)
    .where('deviceId', '=', deviceId)
    .execute();
  return {
    accepted: new Set(accepted.map((row) => row.id)),
    refused: new Map(
      refused.map((row) => [
        row.id,
        { hash: row.hash, code: row.code as RejectionCode, reason: row.reason },
      ]),
    ),
  };
}

/**
 * The earlier refusal of this op, if the server already refused it. A re-push (a retried batch
 * whose response was lost) gets the same answer, never a second verdict: the op's chain position
 * is already spent, so judging it again would read it as a reordered op. Matched on the hash too:
 * only the very op that was refused gets the stored answer. Anything else carrying its id goes
 * through full validation (and fails the binding/chain steps).
 */
export function findRefusal(
  verdicts: BatchVerdicts,
  op: { readonly id: string; readonly hash: string },
): { readonly code: RejectionCode; readonly reason: string } | undefined {
  const refusal = verdicts.refused.get(op.id);
  return refusal?.hash === op.hash ? refusal : undefined;
}
