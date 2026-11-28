// The dialect-neutral shape the `purchasing` appliers and queries are typed against, as inventory's
// schema.ts: no boolean columns (0/1 integers), times are ms epoch integers, quantities integers.
// Column order is the DDL order in both migrations and the manifest.

export interface PurchasingSuppliersTable {
  id: string;
  tenantId: string;
  name: string;
  /** Where its orders are sent on WhatsApp, as typed. */
  phone: string | null;
  note: string | null;
  /** 1 once taken off the list. Its orders stay. */
  archived: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export interface PurchasingOrdersTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** `PO-K7Q-0001`: minted by the device that drafted it, as servisan numbers are. */
  orderNumber: string;
  supplierId: string;
  /** `OrderStatus`. */
  status: string;
  note: string | null;
  createdBy: string;
  createdAt: number;
  orderedBy: string | null;
  orderedAt: number | null;
  cancelledBy: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  updatedAt: number;
}

/** One part on an order: child rows of the order, rewritten while it is a draft. */
export interface PurchasingOrderLinesTable {
  orderId: string;
  position: number;
  tenantId: string;
  itemId: string;
  /** The part's name when it was ordered, as the supplier was told. */
  itemName: string;
  qty: number;
}

export interface PurchasingReceiptsTable {
  id: string;
  tenantId: string;
  storeId: string;
  orderId: string;
  note: string | null;
  userId: string;
  at: number;
}

/** One part a receipt brought in: child rows of the receipt. */
export interface PurchasingReceiptLinesTable {
  receiptId: string;
  position: number;
  tenantId: string;
  orderId: string;
  itemId: string;
  qty: number;
}

/**
 * A supplier's bill for one nota, in one store: its own record, entered before the parts come
 * (paid ahead, or the nota came first) or after. It is compared with its order's deliveries when
 * read, never blocked by them. Its total is its lines plus its charges.
 */
export interface PurchasingBillsTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** `TG-K7Q-0001`: minted by the device that recorded it, as order numbers are. */
  billNumber: string;
  supplierId: string;
  /** The order it bills, when there is one. */
  orderId: string | null;
  /** The supplier's own number for the nota, as printed. */
  supplierRef: string | null;
  /** The nota's date, as ms epoch at the start of that day on the device. */
  billedOn: number;
  /** When it must be paid by ("tempo"), or null for no set date. */
  dueOn: number | null;
  /** Ongkir and other charges on the nota beyond its parts, whole rupiah. */
  charges: number;
  note: string | null;
  /** `BillStatus`. */
  status: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

/** One part on a bill: child rows of the bill, rewritten when it is edited. */
export interface PurchasingBillLinesTable {
  billId: string;
  position: number;
  tenantId: string;
  itemId: string;
  /** The part's name as the bill was entered. */
  itemName: string;
  qty: number;
  /** Whole rupiah per piece. */
  unitPrice: number;
}

/**
 * A payment to a supplier, in one store. It names the bill it pays, or none when paid ahead; what
 * each bill still owes is read from these (bills/balances.ts), so nothing on a bill is rewritten.
 */
export interface PurchasingPaymentsTable {
  id: string;
  tenantId: string;
  storeId: string;
  supplierId: string;
  /** The bill it pays, or null for money paid ahead (the supplier's credit). */
  billId: string | null;
  /** Whole rupiah. */
  amount: number;
  /** `cash`, `account:<id>` or `owner` (constants.ts `OWNER_FUNDS`). */
  source: string;
  /** A bank transfer's reference, as typed. */
  reference: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

export interface PurchasingDatabase {
  purchasingSuppliers: PurchasingSuppliersTable;
  purchasingOrders: PurchasingOrdersTable;
  purchasingOrderLines: PurchasingOrderLinesTable;
  purchasingReceipts: PurchasingReceiptsTable;
  purchasingReceiptLines: PurchasingReceiptLinesTable;
  purchasingBills: PurchasingBillsTable;
  purchasingBillLines: PurchasingBillLinesTable;
  purchasingPayments: PurchasingPaymentsTable;
}
