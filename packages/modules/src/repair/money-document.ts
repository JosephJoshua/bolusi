// A servisan as a money document: what the money module may charge for it (money/documents.ts).
//
// A servisan is charged once its outcome is settled and the phone is still in the store: the agreed
// price of a repaired phone, or the fee of a cancelled one. Its price only counts what the customer
// agreed to, and lowering either needs an owner, so the charge inherits those rules.
import type { Kysely } from 'kysely';

import type { MoneyDocumentSource } from '../money/documents.js';
import { SYSTEM_ACCOUNT } from '../money/constants.js';
import type { RepairDatabase } from './schema.js';

/** The document kind money records name a servisan by. */
export const REPAIR_DOCUMENT_KIND = 'repair.ticket' as const;

function ticketQuery(
  db: Kysely<never>,
  lookup: { tenantId: string; storeId: string; documentId: string },
) {
  return (db as unknown as Kysely<RepairDatabase>)
    .selectFrom('repairTickets')
    .select(['outcome', 'location', 'quoteTotal', 'cancelFee'])
    .where('id', '=', lookup.documentId)
    .where('tenantId', '=', lookup.tenantId)
    .where('storeId', '=', lookup.storeId)
    .executeTakeFirst();
}

export const repairMoneyDocument: MoneyDocumentSource = {
  async exists(db, lookup) {
    return (await ticketQuery(db, lookup)) !== undefined;
  },

  async charge(db, lookup) {
    const ticket = await ticketQuery(db, lookup);
    if (ticket === undefined || ticket.location !== 'in_store') return null;
    if (ticket.outcome === 'repaired') {
      return { amount: Number(ticket.quoteTotal), account: SYSTEM_ACCOUNT.serviceRevenue };
    }
    if (ticket.outcome === 'cancelled') {
      return { amount: Number(ticket.cancelFee ?? 0), account: SYSTEM_ACCOUNT.cancelFeeRevenue };
    }
    return null;
  },
};
