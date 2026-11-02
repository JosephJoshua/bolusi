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

export const INVENTORY_TABLE = {
  items: 'inventory_items',
  movements: 'inventory_movements',
  fits: 'inventory_item_fits',
  facets: 'inventory_item_facets',
  categories: 'inventory_categories',
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
  /** Add parts that arrived from a supplier to the store's stock (with "Belanja sparepart"). */
  receive: 'inventory.receive',
} as const;

/** What a movement was. */
export const MOVEMENT_KINDS = ['counted', 'taken', 'put_back', 'received'] as const;
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
export const STOCK_SOURCE_KINDS = ['purchase_receipt'] as const;
export type StockSourceKind = (typeof STOCK_SOURCE_KINDS)[number];

/** The most of one part a single movement may carry, either way. Catches a mistyped extra zero. */
export const MAX_MOVEMENT_QTY = 10_000;
/** The most a store can count of one part. */
export const MAX_COUNTED_QTY = 1_000_000;
