// What inventory makes searchable, for the shared fuzzy search in @bolusi/core (search/). An item is
// found by its name, the phones it fits, its field values and tags, or its code and barcode, typos
// and all: a shop with thousands of parts finds "lcd redmi not 10 ori" without scrolling.
import type {
  ChangedEntities,
  ReadonlyProjectionDb,
  SearchDocument,
  SearchScope,
  SearchSource,
} from '@bolusi/core';

import { parseValues } from './categories.js';
import { INVENTORY_ITEM_ENTITY, INVENTORY_TABLE, TAG_FACET } from './constants.js';
import type { InventoryDatabase } from './schema.js';

type Db = ReadonlyProjectionDb<InventoryDatabase>;

/** SQLite caps bound parameters; a big sync can change thousands of parts at once. */
const CHUNK = 500;

function partRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('inventoryItems')
    .select(['id', 'name', 'code', 'barcode', 'fits', 'fieldValues', 'archived', 'updatedAt'])
    .where('tenantId', '=', scope.tenantId);
}

type PartSearchRow = Awaited<ReturnType<ReturnType<typeof partRows>['execute']>>[number];

/** One item as the fuzzy search sees it; the browser preview indexes its demo items the same way. */
export function itemDocument(
  row: Pick<PartSearchRow, 'id' | 'name' | 'code' | 'fits'> & {
    readonly barcode?: string | null;
    readonly values?: Readonly<Record<string, readonly string[]>>;
    readonly tags?: readonly string[];
    readonly archived: unknown;
  },
): SearchDocument {
  return {
    id: row.id,
    text: [row.name, row.fits, ...Object.values(row.values ?? {}).flat(), ...(row.tags ?? [])],
    codes: [row.code, row.barcode ?? null],
    // Parts still on the list rank above ones taken off it.
    rank: Number(row.archived) === 1 ? 0 : 1,
  };
}

/** Each item's tags, for the items given (all of the tenant's when `ids` is omitted). */
async function tagsOf(db: Db, scope: SearchScope, ids?: readonly string[]) {
  let query = db
    .selectFrom('inventoryItemFacets')
    .select(['itemId', 'value'])
    .where('tenantId', '=', scope.tenantId)
    .where('facet', '=', TAG_FACET);
  if (ids !== undefined) query = query.where('itemId', 'in', ids);
  const tags = new Map<string, string[]>();
  for (const row of await query.execute()) {
    tags.set(row.itemId, [...(tags.get(row.itemId) ?? []), row.value]);
  }
  return tags;
}

function documents(rows: readonly PartSearchRow[], tags: ReadonlyMap<string, string[]>) {
  return rows.map((row) =>
    itemDocument({ ...row, values: parseValues(row.fieldValues), tags: tags.get(row.id) ?? [] }),
  );
}

export const itemSearchSource: SearchSource<InventoryDatabase> = {
  name: 'inventory.items',
  tables: [INVENTORY_TABLE.items, INVENTORY_TABLE.facets],
  entityTypes: [INVENTORY_ITEM_ENTITY],
  async loadAll(db, scope) {
    return documents(await partRows(db, scope).execute(), await tagsOf(db, scope));
  },
  async loadChanged(db, scope, changed: ChangedEntities) {
    const ids = changed.get(INVENTORY_ITEM_ENTITY) ?? [];
    const found: SearchDocument[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = await partRows(db, scope).where('id', 'in', chunk).execute();
      found.push(...documents(rows, await tagsOf(db, scope, chunk)));
    }
    return { documents: found, checked: ids };
  },
};
