// What inventory makes searchable, for the shared fuzzy search in @bolusi/core (search/). A part is
// found by its name, its code or the phones it fits, typos and all: a shop with thousands of parts
// finds "lcd redmi not 10" without scrolling.
import type {
  ChangedEntities,
  ReadonlyProjectionDb,
  SearchDocument,
  SearchScope,
  SearchSource,
} from '@bolusi/core';

import { INVENTORY_ITEM_ENTITY, INVENTORY_TABLE } from './constants.js';
import type { InventoryDatabase } from './schema.js';

type Db = ReadonlyProjectionDb<InventoryDatabase>;

/** SQLite caps bound parameters; a big sync can change thousands of parts at once. */
const CHUNK = 500;

function partRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('inventoryItems')
    .select(['id', 'name', 'code', 'fits', 'archived', 'updatedAt'])
    .where('tenantId', '=', scope.tenantId);
}

type PartSearchRow = Awaited<ReturnType<ReturnType<typeof partRows>['execute']>>[number];

/** One item as the fuzzy search sees it; the browser preview indexes its demo items the same way. */
export function itemDocument(
  row: Pick<PartSearchRow, 'id' | 'name' | 'code' | 'fits'> & { readonly archived: unknown },
): SearchDocument {
  return {
    id: row.id,
    text: [row.name, row.fits],
    codes: [row.code],
    // Parts still on the list rank above ones taken off it.
    rank: Number(row.archived) === 1 ? 0 : 1,
  };
}

export const itemSearchSource: SearchSource<InventoryDatabase> = {
  name: 'inventory.items',
  tables: [INVENTORY_TABLE.items],
  entityTypes: [INVENTORY_ITEM_ENTITY],
  async loadAll(db, scope) {
    return (await partRows(db, scope).execute()).map(itemDocument);
  },
  async loadChanged(db, scope, changed: ChangedEntities) {
    const ids = changed.get(INVENTORY_ITEM_ENTITY) ?? [];
    const documents: SearchDocument[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await partRows(db, scope)
        .where('id', 'in', ids.slice(i, i + CHUNK))
        .execute();
      documents.push(...rows.map(itemDocument));
    }
    return { documents, checked: ids };
  },
};
