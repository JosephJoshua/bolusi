// Identifiers for the `purchasing` module: buying parts from suppliers (product-scope.md,
// "Purchasing"). One supplier list per business; orders belong to a store.
//
// An order goes Draft, then Dipesan, then is received in one or more receipts. What it has received
// is never stored on the order: each receipt is its own entity, so two phones receiving the same
// order offline never collide, and the order's state is read from its receipts.

import { INVENTORY_PERMISSION } from '../inventory/constants.js';

export const PURCHASING_MODULE_ID = 'purchasing' as const;

/** One supplier, tenant-wide: every store orders from the same list. */
export const PURCHASING_SUPPLIER_ENTITY = 'purchasing_supplier' as const;
/** One order to a supplier, in one store. */
export const PURCHASING_ORDER_ENTITY = 'purchasing_order' as const;
/** One delivery received on an order. */
export const PURCHASING_RECEIPT_ENTITY = 'purchasing_receipt' as const;
/** One supplier bill ("Tagihan supplier"): what a store owes a supplier for one nota. */
export const PURCHASING_BILL_ENTITY = 'purchasing_bill' as const;
/** One payment a store made to a supplier, for a bill or ahead of one. */
export const PURCHASING_PAYMENT_ENTITY = 'purchasing_payment' as const;

export const PURCHASING_TABLE = {
  suppliers: 'purchasing_suppliers',
  orders: 'purchasing_orders',
  orderLines: 'purchasing_order_lines',
  receipts: 'purchasing_receipts',
  receiptLines: 'purchasing_receipt_lines',
  bills: 'purchasing_bills',
  billLines: 'purchasing_bill_lines',
  payments: 'purchasing_payments',
} as const;

export const PURCHASING_OP = {
  supplierAdded: 'purchasing.supplier_added',
  supplierEdited: 'purchasing.supplier_edited',
  orderDrafted: 'purchasing.order_drafted',
  orderEdited: 'purchasing.order_edited',
  orderPlaced: 'purchasing.order_placed',
  orderCancelled: 'purchasing.order_cancelled',
  orderReceived: 'purchasing.order_received',
  billRecorded: 'purchasing.bill_recorded',
  billEdited: 'purchasing.bill_edited',
  billVoided: 'purchasing.bill_voided',
  supplierPaid: 'purchasing.supplier_paid',
  supplierPaymentVoided: 'purchasing.supplier_payment_voided',
} as const;

export const PURCHASING_PERMISSION = {
  /** "Belanja sparepart": keep suppliers, order parts from them and receive what arrives. */
  buy: 'purchasing.buy',
  /**
   * "Tagihan supplier": record the suppliers' bills and read them. A bill carries buy prices, so
   * it is held only where everyone a device syncs for may read it (least-privilege sync).
   */
  bills: 'purchasing.bills',
  /** "Bayar supplier": pay suppliers from the drawer, a store bank account or the owner's money. */
  paySuppliers: 'purchasing.pay_suppliers',
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
/** The most one piece can cost on a bill, in whole rupiah. Catches a mistyped run of zeros. */
export const MAX_UNIT_PRICE = 1_000_000_000;
/** The most a bill's ongkir and other charges can add, in whole rupiah. */
export const MAX_BILL_CHARGES = 1_000_000_000;
/** The supplier's own number for its nota, as printed on it. */
export const MAX_SUPPLIER_REF = 60;

/** The most one supplier payment can be, in whole rupiah (as money's largest record). */
export const MAX_PAYMENT = 1_000_000_000_000;
/** A bank transfer's reference, as money's. */
export const MAX_PAYMENT_REFERENCE = 100;

/**
 * Where a supplier payment comes from: the store's drawer (`cash`), one of its bank accounts
 * (`account:<id>`, a money transfer account), or the owner's own pocket (`owner`), which no store
 * book holds.
 */
export const OWNER_FUNDS = 'owner' as const;

/** What a bill is, as recorded. What is still owed on it is read from its payments. */
export const BILL_STATUSES = ['open', 'void'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** Who sees the suppliers' bills: whoever buys and may read them. */
export function opensBills(
  purchasing: { hasPermission(permissionId: string): boolean } | undefined,
): boolean {
  return (
    purchasing?.hasPermission(PURCHASING_PERMISSION.buy) === true &&
    purchasing.hasPermission(PURCHASING_PERMISSION.bills)
  );
}

/** Who sees Belanja: whoever orders from suppliers, since an order picks from the parts list. */
export function opensPurchasing(
  inventory: { hasPermission(permissionId: string): boolean } | undefined,
  purchasing: { hasPermission(permissionId: string): boolean } | undefined,
): boolean {
  return (
    inventory?.hasPermission(INVENTORY_PERMISSION.read) === true &&
    purchasing?.hasPermission(PURCHASING_PERMISSION.buy) === true
  );
}
