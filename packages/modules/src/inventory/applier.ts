// The `inventory` projection appliers and table manifests.
//
// A part's row is keyed to the part entity; each movement is its own entity and row, so stock never
// needs a re-fold of anything but the one movement that arrived late. Appliers stay total: the rules
// refuse what must not be recorded, and whatever the server accepted still folds.
import type { ProjectionApplier, ProjectionOperation, ProjectionTableManifest } from '@bolusi/core';

import { valueKey, type CategoryField, type FieldValues } from './categories.js';
import {
  INVENTORY_CATEGORY_ENTITY,
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_ITEM_ENTITY,
  TAG_FACET,
  type MovementKind,
} from './constants.js';
import { compactModel } from '../shared/model-key.js';
import type { InventoryDatabase } from './schema.js';

type Applier = ProjectionApplier<InventoryDatabase>;

export const inventoryItemsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    name: 'text',
    name_auto: 'integer',
    code: 'text',
    barcode: 'text',
    category_id: 'text',
    field_values: 'text',
    fits: 'text',
    archived: 'integer',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_ITEM_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/** The phone models a part fits: child rows of the part entity, rewritten with each edit. */
export const inventoryItemFitsTable: ProjectionTableManifest = {
  columns: {
    item_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    brand: 'text',
    model: 'text',
    model_key: 'text',
  },
  primaryKey: ['item_id', 'position'],
  entityType: INVENTORY_ITEM_ENTITY,
  entityIdColumn: 'item_id',
  projectionVersion: 1,
};

/** What an item is filed under (tags, field values): child rows of the item, rewritten with each edit. */
export const inventoryItemFacetsTable: ProjectionTableManifest = {
  columns: {
    item_id: 'text',
    position: 'integer',
    tenant_id: 'text',
    facet: 'text',
    value: 'text',
    value_key: 'text',
  },
  primaryKey: ['item_id', 'position'],
  entityType: INVENTORY_ITEM_ENTITY,
  entityIdColumn: 'item_id',
  projectionVersion: 1,
};

export const inventoryCategoriesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    name: 'text',
    is_part: 'integer',
    fields: 'text',
    name_format: 'text',
    archived: 'integer',
    created_by: 'text',
    created_at: 'integer',
    updated_by: 'text',
    updated_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_CATEGORY_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const inventoryMovementsTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    item_id: 'text',
    kind: 'text',
    qty: 'integer',
    counted: 'integer',
    use_kind: 'text',
    use_id: 'text',
    use_label: 'text',
    note: 'text',
    user_id: 'text',
    at: 'integer',
  },
  primaryKey: ['id'],
  entityType: INVENTORY_MOVEMENT_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

function payloadOf<T>(op: ProjectionOperation): T {
  return op.payload as unknown as T;
}

interface PartFit {
  readonly brand: string;
  readonly model: string;
}

interface PartDetails {
  readonly name: string;
  readonly nameAuto: boolean;
  readonly code: string | null;
  readonly barcode: string | null;
  readonly categoryId: string | null;
  readonly values: FieldValues;
  readonly tags: readonly string[];
  readonly fits: readonly PartFit[];
}

/** The item's columns a details payload sets. */
function detailColumns(payload: PartDetails) {
  return {
    name: payload.name,
    nameAuto: payload.nameAuto ? 1 : 0,
    code: payload.code,
    barcode: payload.barcode,
    categoryId: payload.categoryId,
    fieldValues: JSON.stringify(payload.values),
    fits: fitsLine(payload.fits),
  };
}

async function writeFacets(
  db: Parameters<Applier>[0],
  op: ProjectionOperation,
  payload: PartDetails,
) {
  await db.deleteFrom('inventoryItemFacets').where('itemId', '=', op.entityId).execute();
  const facets = [
    ...payload.tags.map((value) => ({ facet: TAG_FACET as string, value })),
    ...Object.entries(payload.values).flatMap(([facet, values]) =>
      values.map((value) => ({ facet, value })),
    ),
  ];
  if (facets.length === 0) return;
  await db
    .insertInto('inventoryItemFacets')
    .values(
      facets.map((facet, position) => ({
        itemId: op.entityId,
        position,
        tenantId: op.tenantId,
        facet: facet.facet,
        value: facet.value,
        valueKey: valueKey(facet.value),
      })),
    )
    .execute();
}

/** "Xiaomi Redmi Note 10, Poco M5s": the fits as one line, for lists and the search index. */
export function fitsLine(fits: readonly PartFit[]): string | null {
  return fits.length === 0 ? null : fits.map((f) => `${f.brand} ${f.model}`.trim()).join(', ');
}

async function writeFits(
  db: Parameters<Applier>[0],
  op: ProjectionOperation,
  fits: readonly PartFit[],
) {
  await db.deleteFrom('inventoryItemFits').where('itemId', '=', op.entityId).execute();
  if (fits.length === 0) return;
  await db
    .insertInto('inventoryItemFits')
    .values(
      fits.map((fit, position) => ({
        itemId: op.entityId,
        position,
        tenantId: op.tenantId,
        brand: fit.brand,
        model: fit.model,
        modelKey: compactModel(fit.brand, fit.model),
      })),
    )
    .execute();
}

export const itemAddedApplier: Applier = async (db, op) => {
  const payload = payloadOf<PartDetails>(op);
  await db
    .insertInto('inventoryItems')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      ...detailColumns(payload),
      archived: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .execute();
  await writeFits(db, op, payload.fits);
  await writeFacets(db, op, payload);
};

export const itemEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<PartDetails & { readonly archived: boolean }>(op);
  await db
    .updateTable('inventoryItems')
    .set({
      ...detailColumns(payload),
      archived: payload.archived ? 1 : 0,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
  await writeFits(db, op, payload.fits);
  await writeFacets(db, op, payload);
};

interface CategoryDetails {
  readonly name: string;
  readonly isPart: boolean;
  readonly fields: readonly CategoryField[];
  readonly nameFormat: string;
}

function categoryColumns(payload: CategoryDetails) {
  return {
    name: payload.name,
    isPart: payload.isPart ? 1 : 0,
    fields: JSON.stringify(payload.fields),
    nameFormat: payload.nameFormat,
  };
}

export const categoryAddedApplier: Applier = async (db, op) => {
  const payload = payloadOf<CategoryDetails>(op);
  await db
    .insertInto('inventoryCategories')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      ...categoryColumns(payload),
      archived: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .execute();
};

export const categoryEditedApplier: Applier = async (db, op) => {
  const payload = payloadOf<CategoryDetails & { readonly archived: boolean }>(op);
  await db
    .updateTable('inventoryCategories')
    .set({
      ...categoryColumns(payload),
      archived: payload.archived ? 1 : 0,
      updatedBy: op.userId,
      updatedAt: op.timestamp,
    })
    .where('id', '=', op.entityId)
    .where('tenantId', '=', op.tenantId)
    .execute();
};

interface Movement {
  readonly itemId: string;
  readonly kind: MovementKind;
  readonly qty: number;
  readonly counted: number | null;
  readonly use: { readonly kind: string; readonly id: string; readonly label: string } | null;
  readonly note: string | null;
}

async function insertMovement(
  db: Parameters<Applier>[0],
  op: ProjectionOperation,
  movement: Movement,
): Promise<void> {
  await db
    .insertInto('inventoryMovements')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      // Movement ops are store-scoped, so the store is always stamped.
      storeId: op.storeId ?? '',
      itemId: movement.itemId,
      kind: movement.kind,
      qty: movement.qty,
      counted: movement.counted,
      useKind: movement.use?.kind ?? null,
      useId: movement.use?.id ?? null,
      useLabel: movement.use?.label ?? null,
      note: movement.note,
      userId: op.userId,
      at: op.timestamp,
    })
    .execute();
}

export const stockCountedApplier: Applier = async (db, op) => {
  const payload = payloadOf<{
    itemId: string;
    counted: number;
    expected: number;
    note: string | null;
  }>(op);
  await insertMovement(db, op, {
    itemId: payload.itemId,
    kind: 'counted',
    qty: payload.counted - payload.expected,
    counted: payload.counted,
    use: null,
    note: payload.note,
  });
};

interface UsePayload {
  readonly itemId: string;
  readonly qty: number;
  readonly use: { readonly kind: string; readonly id: string; readonly label: string };
}

export const itemTakenApplier: Applier = async (db, op) => {
  const payload = payloadOf<UsePayload>(op);
  await insertMovement(db, op, {
    itemId: payload.itemId,
    kind: 'taken',
    qty: -payload.qty,
    counted: null,
    use: payload.use,
    note: null,
  });
};

export const itemPutBackApplier: Applier = async (db, op) => {
  const payload = payloadOf<UsePayload>(op);
  await insertMovement(db, op, {
    itemId: payload.itemId,
    kind: 'put_back',
    qty: payload.qty,
    counted: null,
    use: payload.use,
    note: null,
  });
};
