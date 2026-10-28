// Permits: an approval of a kind that makes no decision when approved (kinds.ts, no `handler`), so
// the owning module's rules read it when the counter uses it later. Read the same way on the device
// and the server, inside the op's own store.
import type { Kysely } from 'kysely';

import type { ApprovalsDatabase } from './schema.js';

/** The most an approved permit of `kind` on `targetId` allows, or null when none was approved. */
export async function approvedPermit(
  db: Kysely<never>,
  at: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly kind: string;
    readonly targetId: string;
  },
): Promise<number | null> {
  const rows = await (db as unknown as Kysely<ApprovalsDatabase>)
    .selectFrom('approvalRequests')
    .select('amount')
    .where('tenantId', '=', at.tenantId)
    .where('storeId', '=', at.storeId)
    .where('kind', '=', at.kind)
    .where('targetId', '=', at.targetId)
    .where('status', '=', 'approved')
    .execute();
  return rows.length === 0 ? null : Math.max(...rows.map((row) => Number(row.amount)));
}
