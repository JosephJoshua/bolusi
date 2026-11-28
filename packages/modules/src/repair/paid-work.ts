// Servisan a technician finished and handed over, for whatever pays them for it (the `pay`
// module's commission). Read here, from repair's own tables, so pay never reads them.
//
// A servisan counts when it was repaired and the phone has gone home: after "Ganti teknisi", the
// technician it went home under is the one who finished it. A warranty claim never counts (the
// customer pays nothing), nor does a cancelled one (its fee is not repair work). A handover taken
// back puts the phone in the store again, so it stops counting until it goes home again.
import type { ReadonlyProjectionDb } from '@bolusi/core';

import type { RepairDatabase } from './schema.js';

export interface HandedOverRepair {
  readonly id: string;
  readonly ticketNumber: string;
  readonly technicianId: string;
  /** When the phone first went home. */
  readonly returnedAt: number;
}

export async function handedOverRepairs(
  db: ReadonlyProjectionDb<RepairDatabase>,
  scope: { readonly tenantId: string; readonly storeId: string },
  options: { readonly until: number; readonly technicianId: string | null },
): Promise<HandedOverRepair[]> {
  let query = db
    .selectFrom('repairTickets')
    .select(['id', 'ticketNumber', 'technicianId', 'returnedAt'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where('outcome', '=', 'repaired')
    .where('location', '=', 'returned')
    .where('claimOfTicketId', 'is', null)
    .where('technicianId', 'is not', null)
    .where('returnedAt', '<=', options.until);
  if (options.technicianId !== null) {
    query = query.where('technicianId', '=', options.technicianId);
  }
  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    ticketNumber: row.ticketNumber,
    technicianId: row.technicianId!,
    returnedAt: Number(row.returnedAt),
  }));
}
