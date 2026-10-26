// Idempotent replay: dedupe by op `id` (05 §5). Runs first, per op. A replayed already-accepted
// op returns `duplicate`, consumes no serverSeq, inserts nothing, records no anomaly. The lookup
// is RLS-scoped (tenant-bound handle), served by the operations PK on `id` (10-db §10).
import type { TenantDb } from '@bolusi/db-server';
import type { RejectionCode } from '@bolusi/schemas';

export async function isDuplicate(db: TenantDb, opId: string): Promise<boolean> {
  const row = await db
    .selectFrom('operations')
    .select('id')
    .where('id', '=', opId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The earlier refusal of this op, if the server already refused it. A re-push (a retried batch
 * whose response was lost) gets the same answer, never a second verdict: the op's chain position
 * is already spent, so judging it again would read it as a reordered op.
 */
export async function findRefusal(
  db: TenantDb,
  op: { readonly id: string; readonly deviceId: string; readonly hash: string },
): Promise<{ readonly code: RejectionCode; readonly reason: string } | undefined> {
  // Matched on the device and hash too: only the very op that was refused gets the stored answer.
  // Anything else carrying its id goes through full validation (and fails the binding/chain steps).
  const row = await db
    .selectFrom('refusedOperations')
    .select(['code', 'reason'])
    .where('id', '=', op.id)
    .where('deviceId', '=', op.deviceId)
    .where('hash', '=', op.hash)
    .executeTakeFirst();
  return row === undefined ? undefined : { code: row.code as RejectionCode, reason: row.reason };
}
