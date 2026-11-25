// Identifiers for the `inventory` module: the business's parts list and each store's stock
// (product-scope.md, "Parts and stock").
//
// Stock is never stored as a number to overwrite. Every change is a movement (a count, a part taken
// for a servisan, a part put back), and what a store has is the sum of its movements. Each movement
// is its own entity, so two phones moving the same part offline never collide and a re-fold touches
// one row.

export const INVENTORY_MODULE_ID = 'inventory' as const;

/** One part on the business's list. Tenant-wide: every store sees the same list. */
export const INVENTORY_ITEM_ENTITY = 'inventory_item' as const;
/** One category of the list (LCD, Baterai, Charger), with the fields its items fill in. */
export const INVENTORY_CATEGORY_ENTITY = 'inventory_category' as const;
/** One stock movement in one store. */
export const INVENTORY_MOVEMENT_ENTITY = 'inventory_movement' as const;
/** One transfer of parts from one store to another (transfers/). */
export const INVENTORY_TRANSFER_ENTITY = 'inventory_transfer' as const;
/** One arrival of a transfer's parts at the store it was sent to. */
export const INVENTORY_TRANSFER_ARRIVAL_ENTITY = 'inventory_transfer_arrival' as const;
/** One owner's settlement of a transfer's parts that never arrived (or arrived after all). */
export const INVENTORY_TRANSFER_SETTLEMENT_ENTITY = 'inventory_transfer_settlement' as const;
/**
 * What one received movement cost to buy, keyed by that movement's id. Its own entity and table,
 * read only with `inventory.read_cost`, so a store device holds stock moves without their cost.
 */
export const INVENTORY_COST_ENTITY = 'inventory_cost' as const;

export const INVENTORY_TABLE = {
  items: 'inventory_items',
  movements: 'inventory_movements',
  fits: 'inventory_item_fits',
  facets: 'inventory_item_facets',
  categories: 'inventory_categories',
  transfers: 'inventory_transfers',
  transferLines: 'inventory_transfer_lines',
  transferArrivals: 'inventory_transfer_arrivals',
  transferArrivalLines: 'inventory_transfer_arrival_lines',
  transferSettlements: 'inventory_transfer_settlements',
  transferSettlementLines: 'inventory_transfer_settlement_lines',
  costs: 'inventory_costs',
} as const;

/** The most phone models one part can list as fitting. */
export const MAX_PART_FITS = 50;

/** What a category field holds: one pick, several picks, free text, or the phones the item fits. */
export const FIELD_KINDS = ['one', 'many', 'text', 'phones'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Category limits: enough for any real list, small enough that a mistake cannot balloon a sync. */
export const MAX_CATEGORY_FIELDS = 12;
export const MAX_FIELD_OPTIONS = 100;
export const MAX_ITEM_TAGS = 20;
/** The facet a tag is filed under in `inventory_item_facets`; field values use the field's id. */
export const TAG_FACET = 'tag' as const;

export const INVENTORY_OP = {
  categoryAdded: 'inventory.category_added',
  categoryEdited: 'inventory.category_edited',
  itemAdded: 'inventory.item_added',
  itemEdited: 'inventory.item_edited',
  stockCounted: 'inventory.stock_counted',
  itemTaken: 'inventory.item_taken',
  itemPutBack: 'inventory.item_put_back',
  stockReceived: 'inventory.stock_received',
  stockSent: 'inventory.stock_sent',
  transferSent: 'inventory.transfer_sent',
  transferReceived: 'inventory.transfer_received',
  transferCancelled: 'inventory.transfer_cancelled',
  transferSettled: 'inventory.transfer_settled',
  stockCosted: 'inventory.stock_costed',
} as const;

export const INVENTORY_PERMISSION = {
  read: 'inventory.read',
  /** Set up the categories, their fields and how their items are named (the business owner). */
  manageCategories: 'inventory.manage_categories',
  /** Add parts to the business's list and edit them. */
  manageItems: 'inventory.manage_items',
  /** Set how many of a part the store has, from a count. */
  count: 'inventory.count',
  /** Take parts for a servisan and put them back, while it is being worked on. */
  useParts: 'inventory.use_parts',
  /** Take or put back parts on a servisan that is no longer being worked on (owners). */
  correctUse: 'inventory.correct_use',
  /** Add parts that arrived (from a supplier, or sent by another store) to the store's stock. */
  receive: 'inventory.receive',
  /** "Kirim sparepart antar toko": send parts to another store, and cancel a send not yet received. */
  transfer: 'inventory.transfer',
  /** Settle what a sent transfer is missing: back into stock, or written off (owners). */
  settleTransfer: 'inventory.settle_transfer',
  /**
   * "Lihat harga beli": what parts cost to buy and each store's average cost. Devices hold costs
   * only where everyone they sync for may read them (least-privilege sync).
   */
  readCost: 'inventory.read_cost',
} as const;

/** What a movement was. */
export const MOVEMENT_KINDS = ['counted', 'taken', 'put_back', 'received', 'sent'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * What parts can be taken for. Each kind is checked by the module that owns it (part-use.ts), so
 * the stock rules never read another module's records themselves.
 */
export const PART_USE_KINDS = ['repair_ticket'] as const;
export type PartUseKind = (typeof PART_USE_KINDS)[number];

/**
 * Where received parts came from. Each kind is checked by the module that owns it
 * (stock-source.ts), as part uses are: a purchase receipt by purchasing.
 */
export const OUTSIDE_STOCK_SOURCE_KINDS = ['purchase_receipt'] as const;
export type OutsideStockSourceKind = (typeof OUTSIDE_STOCK_SOURCE_KINDS)[number];

/**
 * Parts coming in from a transfer, which inventory checks itself: an arrival at the store it was
 * sent to, or parts back at the sender (a cancel, or an owner settling what never arrived).
 */
export const TRANSFER_STOCK_SOURCE_KINDS = [
  'transfer_arrival',
  'transfer_cancel',
  'transfer_settlement',
] as const;

export const STOCK_SOURCE_KINDS = [
  ...OUTSIDE_STOCK_SOURCE_KINDS,
  ...TRANSFER_STOCK_SOURCE_KINDS,
] as const;
export type StockSourceKind = (typeof STOCK_SOURCE_KINDS)[number];

/**
 * Where sent parts go. A transfer on its way to another store, or an owner's settlement saying
 * parts the sender took back did arrive after all. Later, a return to a supplier.
 */
export const STOCK_SINK_KINDS = ['transfer', 'transfer_settlement'] as const;
export type StockSinkKind = (typeof STOCK_SINK_KINDS)[number];

/**
 * What an owner decides for a transfer's parts. Missing ones are `back` on the sender's shelf or
 * `lost` (written off). When more turns out accounted for than was sent (parts the receiver
 * counted in after all), a write-off is undone as `found` (no stock moves: the parts never came
 * back) and a take-back as `arrived` (they leave the sender's stock again).
 */
export const SETTLEMENT_OUTCOMES = ['back', 'lost', 'found', 'arrived'] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/**
 * How a transfer reads: on its way with nothing in yet; part of it in and the rest not; done
 * (everything arrived or settled); cancelled; or more accounted for than was sent (an arrival
 * recorded offline after the sender took the parts back), for the sending owner to check.
 */
export const TRANSFER_STAGES = ['sent', 'partial', 'done', 'cancelled', 'over'] as const;
export type TransferStage = (typeof TRANSFER_STAGES)[number];

/** Limits: as an order's, enough for any real transfer. */
export const MAX_TRANSFER_LINES = 200;

/** The most of one part a single movement may carry, either way. Catches a mistyped extra zero. */
export const MAX_MOVEMENT_QTY = 10_000;
/** The most a store can count of one part. */
export const MAX_COUNTED_QTY = 1_000_000;
/** The most one piece can cost to buy, in whole rupiah. Catches a mistyped run of zeros. */
export const MAX_UNIT_COST = 1_000_000_000;

/** Who sees the parts list. */
export function opensParts(reader: { hasPermission(permissionId: string): boolean }): boolean {
  return reader.hasPermission(INVENTORY_PERMISSION.read);
}
