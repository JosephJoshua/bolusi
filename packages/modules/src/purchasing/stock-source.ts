// Purchasing's say over parts coming into stock from a receipt. The inventory receive rule calls
// this on the device and on the server: a part comes in only as a receipt in this store lists it,
// in its quantity, recorded by the same person. Inventory refuses a second movement for it.
import type { Kysely } from 'kysely';

import type { StockSourceTarget } from '../inventory/stock-source.js';
import { PURCHASING_RECEIPT_ENTITY } from './constants.js';
import { PURCHASING_REFUSALS } from './rules.js';
import type { PurchasingDatabase } from './schema.js';

const { refuse } = PURCHASING_REFUSALS;

export const purchaseReceiptSource: StockSourceTarget = {
  async check({ op, sourceId, itemId, qty, db }) {
    const row = await (db as Kysely<PurchasingDatabase>)
      .selectFrom('purchasingReceipts as r')
      .innerJoin('purchasingOrders as o', 'o.id', 'r.orderId')
      .leftJoin('purchasingReceiptLines as l', (join) =>
        join.onRef('l.receiptId', '=', 'r.id').on('l.itemId', '=', itemId),
      )
      .select(['o.orderNumber', 'r.userId', 'l.qty'])
      .where('r.id', '=', sourceId)
      .where('r.tenantId', '=', op.tenantId)
      .where('r.storeId', '=', op.storeId ?? '')
      .executeTakeFirst();
    if (row === undefined) {
      throw refuse('orderNotFound', {
        code: 'ENTITY_NOT_FOUND',
        details: { entityType: PURCHASING_RECEIPT_ENTITY, entityId: sourceId },
      });
    }
    if (row.qty === null || Number(row.qty) !== qty || row.userId !== op.userId) {
      throw refuse('receiptMismatch', {
        code: 'VALIDATION_FAILED',
        details: { field: 'qty', issue: 'not as the receipt lists it' },
      });
    }
    return { label: row.orderNumber };
  },
};
