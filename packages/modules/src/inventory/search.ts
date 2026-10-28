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

import { INVENTORY_PART_ENTITY, INVENTORY_TABLE } from './constants.js';
import type { InventoryDatabase } from './schema.js';

type Db = ReadonlyProjectionDb<InventoryDatabase>;

/** SQLite caps bound parameters; a big sync can change thousands of parts at once. */
const CHUNK = 500;

function partRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('inventoryParts')
    .select(['id', 'name', 'code', 'fits', 'archived', 'updatedAt'])
    .where('tenantId', '=', scope.tenantId);
}

type PartSearchRow = Awaited<ReturnType<ReturnType<typeof partRows>['execute']>>[number];

function partDocument(row: PartSearchRow): SearchDocument {
  return {
    id: row.id,
    text: [row.name, row.fits],
    codes: [row.code],
    // Parts still on the list rank above ones taken off it.
    rank: Number(row.archived) === 1 ? 0 : 1,
  };
}

export const partSearchSource: SearchSource<InventoryDatabase> = {
  name: 'inventory.parts',
  tables: [INVENTORY_TABLE.parts],
  entityTypes: [INVENTORY_PART_ENTITY],
  async loadAll(db, scope) {
    return (await partRows(db, scope).execute()).map(partDocument);
  },
  async loadChanged(db, scope, changed: ChangedEntities) {
    const ids = changed.get(INVENTORY_PART_ENTITY) ?? [];
    const documents: SearchDocument[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await partRows(db, scope)
        .where('id', 'in', ids.slice(i, i + CHUNK))
        .execute();
      documents.push(...rows.map(partDocument));
    }
    return { documents, checked: ids };
  },
};
