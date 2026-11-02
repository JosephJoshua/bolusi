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

export interface PurchasingDatabase {
  purchasingSuppliers: PurchasingSuppliersTable;
  purchasingOrders: PurchasingOrdersTable;
  purchasingOrderLines: PurchasingOrderLinesTable;
  purchasingReceipts: PurchasingReceiptsTable;
  purchasingReceiptLines: PurchasingReceiptLinesTable;
}
