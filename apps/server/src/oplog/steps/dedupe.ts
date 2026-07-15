// Idempotent replay: dedupe by op `id` (05 §5). Runs first, per op. A replayed already-accepted
// op returns `duplicate`, consumes no serverSeq, inserts nothing, records no anomaly. The lookup
// is RLS-scoped (tenant-bound handle), served by the operations PK on `id` (10-db §10).
import type { TenantDb } from '@bolusi/db-server';

export async function isDuplicate(db: TenantDb, opId: string): Promise<boolean> {
  const row = await db
    .selectFrom('operations')
    .select('id')
    .where('id', '=', opId)
    .executeTakeFirst();
  return row !== undefined;
}
