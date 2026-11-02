// Identifiers for the `purchasing` module: buying parts from suppliers (product-scope.md,
// "Purchasing"). One supplier list per business; orders belong to a store.
//
// An order goes Draft, then Dipesan, then is received in one or more receipts. What it has received
// is never stored on the order: each receipt is its own entity, so two phones receiving the same
// order offline never collide, and the order's state is read from its receipts.

export const PURCHASING_MODULE_ID = 'purchasing' as const;

/** One supplier, tenant-wide: every store orders from the same list. */
export const PURCHASING_SUPPLIER_ENTITY = 'purchasing_supplier' as const;
/** One order to a supplier, in one store. */
export const PURCHASING_ORDER_ENTITY = 'purchasing_order' as const;
/** One delivery received on an order. */
export const PURCHASING_RECEIPT_ENTITY = 'purchasing_receipt' as const;

export const PURCHASING_TABLE = {
  suppliers: 'purchasing_suppliers',
  orders: 'purchasing_orders',
  orderLines: 'purchasing_order_lines',
  receipts: 'purchasing_receipts',
  receiptLines: 'purchasing_receipt_lines',
} as const;

export const PURCHASING_OP = {
  supplierAdded: 'purchasing.supplier_added',
  supplierEdited: 'purchasing.supplier_edited',
  orderDrafted: 'purchasing.order_drafted',
  orderEdited: 'purchasing.order_edited',
  orderPlaced: 'purchasing.order_placed',
  orderCancelled: 'purchasing.order_cancelled',
  orderReceived: 'purchasing.order_received',
} as const;

export const PURCHASING_PERMISSION = {
  /** "Belanja sparepart": keep suppliers, order parts from them and receive what arrives. */
  buy: 'purchasing.buy',
} as const;

/** What an order is, as recorded. Whether it has arrived is read from its receipts. */
export const ORDER_STATUSES = ['draft', 'ordered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * How an order reads: a draft; ordered and nothing in yet; part of it in; all of it in; more in
 * than ordered (two phones received it offline, or the supplier sent extra); or cancelled.
 */
export const ORDER_STAGES = [
  'draft',
  'ordered',
  'partial',
  'received',
  'over',
  'cancelled',
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** Limits: enough for any real order, small enough that a mistake cannot balloon a sync. */
export const MAX_ORDER_LINES = 200;
export const MAX_LINE_QTY = 10_000;
export const MAX_SUPPLIER_NAME = 120;
export const MAX_SUPPLIER_PHONE = 30;
export const MAX_PURCHASING_NOTE = 500;
/** As inventory's part name, so a line can carry any part's name. */
export const MAX_LINE_NAME = 200;
