// The dialect-neutral shape the `inventory` appliers and queries are typed against, as repair's
// schema.ts: no boolean columns (0/1 integers), times are ms epoch integers, quantities integers.
// Column order is the DDL order in both migrations and the manifest.

export interface InventoryItemsTable {
  id: string;
  tenantId: string;
  /** What the shop calls it: `LCD Redmi Note 10 + frame`. */
  name: string;
  /** 1 when `name` is built from the category's name format; 0 when someone typed it. */
  nameAuto: number;
  /** The supplier's or shop's code, if it has one. */
  code: string | null;
  /** What its barcode or QR code reads, to find it by scanning. */
  barcode: string | null;
  /** `inventory_categories.id`, or null for an item filed under no category. */
  categoryId: string | null;
  /**
   * What it has in each of its category's fields, as JSON `{ [fieldId]: string[] }`. The same values
   * are rows of `inventory_item_facets` for filtering.
   */
  fieldValues: string;
  /**
   * The phones it fits, as one line for lists and search: `Xiaomi Redmi Note 10, Xiaomi Poco M5s`.
   * The models themselves are rows of `inventory_item_fits`.
   */
  fits: string | null;
  /** 1 once taken off the list. Its history stays; it can no longer be taken. */
  archived: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

export interface InventoryMovementsTable {
  id: string;
  tenantId: string;
  storeId: string;
  itemId: string;
  /** `MovementKind`. */
  kind: string;
  /** Signed change to the store's stock: a take is negative, a put-back positive. */
  qty: number;
  /** For a count: how many were counted. Null otherwise. */
  counted: number | null;
  /** What the part was taken for (`PartUseKind`), or null. */
  useKind: string | null;
  useId: string | null;
  /** How the use read when the part was taken (a servisan number), for lists that show it. */
  useLabel: string | null;
  note: string | null;
  userId: string;
  at: number;
}

/**
 * What one received movement cost a piece to buy. Its own table, read only by those who may see
 * costs, so a store device can hold every stock move without what it cost.
 */
export interface InventoryCostsTable {
  /** The `received` movement it prices. */
  movementId: string;
  tenantId: string;
  storeId: string;
  itemId: string;
  /** Whole rupiah per piece. */
  unitCost: number;
  /** Who typed this price, and when. */
  userId: string;
  at: number;
}

/** One phone model a part fits, picked from the phone catalog (or typed when it is not there). */
export interface InventoryItemFitsTable {
  itemId: string;
  /** Order as picked. */
  position: number;
  tenantId: string;
  /** Empty when only the model was typed. */
  brand: string;
  model: string;
  /** `compactModel(brand, model)`: how a servisan's phone finds the parts that fit it. */
  modelKey: string;
}

/**
 * One value an item is filed under, to filter by: a tag (`facet` = 'tag') or a value of one of its
 * category's fields (`facet` = the field's id). Child rows of the item, rewritten with each edit.
 */
export interface InventoryItemFacetsTable {
  itemId: string;
  position: number;
  tenantId: string;
  facet: string;
  /** As entered: `+ frame`. */
  value: string;
  /** `normalizeText(value)`: what filters match, so `+ Frame` and `+ frame` are one value. */
  valueKey: string;
}

/** A category of the list, tenant-wide. */
export interface InventoryCategoriesTable {
  id: string;
  tenantId: string;
  name: string;
  /** 1 when its items are spareparts: only those are offered when taking parts for a servisan. */
  isPart: number;
  /** JSON `CategoryField[]` (categories.ts): its fields, in form order. */
  fields: string;
  /** How its items are named, with a field's label in braces: `LCD {HP} {Kualitas} {Tambahan}`. */
  nameFormat: string;
  archived: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

/**
 * One transfer: parts sent from one store (`storeId`, which mints its number) to another. What has
 * arrived or been settled is never stored here: arrivals and settlements are their own entities, so
 * the two stores recording offline never overwrite each other.
 */
export interface InventoryTransfersTable {
  id: string;
  tenantId: string;
  /** The sending store. */
  storeId: string;
  toStoreId: string;
  /** `TR-K7Q-0001`: minted by the sending device, as order numbers are. */
  transferNumber: string;
  note: string | null;
  sentBy: string;
  sentAt: number;
  cancelledBy: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
}

/** One part sent: child rows of the transfer. */
export interface InventoryTransferLinesTable {
  transferId: string;
  position: number;
  tenantId: string;
  itemId: string;
  /** The part's name when it was sent. */
  itemName: string;
  qty: number;
}

/** One arrival of a transfer's parts at the receiving store (`storeId`). */
export interface InventoryTransferArrivalsTable {
  id: string;
  tenantId: string;
  storeId: string;
  transferId: string;
  note: string | null;
  userId: string;
  at: number;
}

export interface InventoryTransferArrivalLinesTable {
  arrivalId: string;
  position: number;
  tenantId: string;
  transferId: string;
  itemId: string;
  qty: number;
}

/** An owner of the sending store (`storeId`) settling parts that did not arrive, or did after all. */
export interface InventoryTransferSettlementsTable {
  id: string;
  tenantId: string;
  storeId: string;
  transferId: string;
  reason: string | null;
  userId: string;
  at: number;
}

export interface InventoryTransferSettlementLinesTable {
  settlementId: string;
  position: number;
  tenantId: string;
  transferId: string;
  itemId: string;
  /** `SettlementOutcome`. */
  outcome: string;
  qty: number;
}

export interface InventoryDatabase {
  inventoryTransfers: InventoryTransfersTable;
  inventoryTransferLines: InventoryTransferLinesTable;
  inventoryTransferArrivals: InventoryTransferArrivalsTable;
  inventoryTransferArrivalLines: InventoryTransferArrivalLinesTable;
  inventoryTransferSettlements: InventoryTransferSettlementsTable;
  inventoryTransferSettlementLines: InventoryTransferSettlementLinesTable;
  inventoryCategories: InventoryCategoriesTable;
  inventoryCosts: InventoryCostsTable;
  inventoryItemFacets: InventoryItemFacetsTable;
  inventoryItems: InventoryItemsTable;
  inventoryMovements: InventoryMovementsTable;
  inventoryItemFits: InventoryItemFitsTable;
}
