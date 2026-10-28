// The dialect-neutral shape the `inventory` appliers and queries are typed against, as repair's
// schema.ts: no boolean columns (0/1 integers), times are ms epoch integers, quantities integers.
// Column order is the DDL order in both migrations and the manifest.

export interface InventoryPartsTable {
  id: string;
  tenantId: string;
  /** What the shop calls it: `LCD Redmi Note 10 + frame`. */
  name: string;
  /** The supplier's or shop's code, if it has one. */
  code: string | null;
  /**
   * The phones it fits, as one line for lists and search: `Xiaomi Redmi Note 10, Xiaomi Poco M5s`.
   * The models themselves are rows of `inventory_part_fits`.
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
  partId: string;
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

/** One phone model a part fits, picked from the phone catalog (or typed when it is not there). */
export interface InventoryPartFitsTable {
  partId: string;
  /** Order as picked. */
  position: number;
  tenantId: string;
  /** Empty when only the model was typed. */
  brand: string;
  model: string;
  /** `compactModel(brand, model)`: how a servisan's phone finds the parts that fit it. */
  modelKey: string;
}

export interface InventoryDatabase {
  inventoryParts: InventoryPartsTable;
  inventoryMovements: InventoryMovementsTable;
  inventoryPartFits: InventoryPartFitsTable;
}
