// Purchasing's say over money paid to a supplier (money payouts.ts): the money rules ask it, on
// the device and on the server, whether the owner's payment behind a payout is there and what it
// says.
import type { Kysely } from 'kysely';

import { SYSTEM_ACCOUNT } from '../../money/constants.js';
import type { MoneyPayoutSource } from '../../money/payouts.js';
import { OWNER_FUNDS } from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';

/** The ledger account a payment's source pays from: the owner's own money is their capital. */
export function payoutAccountOf(source: string): string {
  return source === OWNER_FUNDS ? SYSTEM_ACCOUNT.ownerCapital : source;
}

export const supplierPaymentPayout: MoneyPayoutSource = {
  async find(db, { tenantId, storeId, id }) {
    const row = await (db as unknown as Kysely<PurchasingDatabase>)
      .selectFrom('purchasingPayments')
      .select(['amount', 'source', 'createdBy', 'voidedAt'])
      .where('id', '=', id)
      .where('tenantId', '=', tenantId)
      .where('storeId', '=', storeId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      amount: Number(row.amount),
      account: payoutAccountOf(row.source),
      userId: row.createdBy,
      voided: row.voidedAt !== null,
    };
  },
};
