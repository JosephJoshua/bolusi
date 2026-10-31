// The `inventory` op types. Parts are tenant-scoped (every store sees one list); movements are
// store-scoped. Payloads are `.strict()` and carry nulls rather than absent keys.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import {
  categoryAddedApplier,
  categoryEditedApplier,
  itemAddedApplier,
  itemEditedApplier,
  itemPutBackApplier,
  itemTakenApplier,
  stockCountedApplier,
  stockReceivedApplier,
} from './applier.js';
import { MAX_FIELD_VALUE, zCategoryShape, zFieldValues } from './categories.js';
import {
  INVENTORY_CATEGORY_ENTITY,
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  MAX_PART_FITS,
  INVENTORY_ITEM_ENTITY,
  INVENTORY_PERMISSION,
  MAX_COUNTED_QTY,
  MAX_ITEM_TAGS,
  MAX_MOVEMENT_QTY,
  PART_USE_KINDS,
  STOCK_SOURCE_KINDS,
} from './constants.js';
import type { PartUseTargets } from './part-use.js';
import {
  categoryAddedRule,
  categoryEditedRule,
  itemAddedRule,
  itemEditedRule,
  itemPutBackRule,
  itemTakenRule,
  stockCountedRule,
  stockReceivedRule,
} from './rules.js';
import type { InventoryDatabase } from './schema.js';
import type { StockSourceTargets } from './stock-source.js';

export const MAX_PART_NAME = 200;
export const MAX_PART_CODE = 60;
export const MAX_BARCODE = 120;
export const MAX_NOTE = 500;

const zName = z.string().trim().min(1).max(MAX_PART_NAME);
const zOptional = (max: number) => z.string().trim().min(1).max(max).nullable();

/** A phone model a part fits: the catalog's brand and model, or a model typed with no brand.
 * Limits match the catalog's (repair/device-models.ts), so any catalog model can be picked. */
export const zPartFit = z
  .object({ brand: z.string().trim().max(100), model: z.string().trim().min(1).max(200) })
  .strict();

export const partDetailsPayload = z
  .object({
    name: zName,
    /** True when the name is the category's format filled in; a format change renames it. */
    nameAuto: z.boolean(),
    code: zOptional(MAX_PART_CODE),
    barcode: zOptional(MAX_BARCODE),
    categoryId: zUuidV7.nullable(),
    values: zFieldValues,
    tags: z.array(z.string().trim().min(1).max(MAX_FIELD_VALUE)).max(MAX_ITEM_TAGS),
    fits: z.array(zPartFit).max(MAX_PART_FITS),
  })
  .strict();

export const categoryAddedPayload = zCategoryShape.extend({ isPart: z.boolean() }).strict();

export const categoryEditedPayload = categoryAddedPayload
  .extend({ archived: z.boolean() })
  .strict();

export const itemAddedPayload = partDetailsPayload;

export const itemEditedPayload = partDetailsPayload.extend({ archived: z.boolean() }).strict();

const zQty = z.number().int().min(1).max(MAX_MOVEMENT_QTY);

export const stockCountedPayload = z
  .object({
    itemId: zUuidV7,
    counted: z.number().int().min(0).max(MAX_COUNTED_QTY),
    /** What the counting device showed, kept so the history can say how far off the record was.
     * Stock itself is the latest count plus what moved after it (queries.ts). */
    expected: z.number().int().min(-MAX_COUNTED_QTY).max(MAX_COUNTED_QTY),
    note: zOptional(MAX_NOTE),
  })
  .strict();

export const zPartUse = z
  .object({ kind: z.enum(PART_USE_KINDS), id: zUuidV7, label: z.string().min(1).max(60) })
  .strict();

export const itemTakenPayload = z.object({ itemId: zUuidV7, qty: zQty, use: zPartUse }).strict();

export const itemPutBackPayload = itemTakenPayload;

export const zStockSource = z
  .object({ kind: z.enum(STOCK_SOURCE_KINDS), id: zUuidV7, label: z.string().min(1).max(60) })
  .strict();

/** Parts that arrived, and the receipt (or later, transfer) that brought them. */
export const stockReceivedPayload = z
  .object({ itemId: zUuidV7, qty: zQty, source: zStockSource })
  .strict();

/**
 * The op declarations. Rules that check a part's use, or where received parts came from, need the
 * targets the composition wires.
 */
export function inventoryOperations(
  targets: PartUseTargets,
  sources: StockSourceTargets,
): Readonly<Record<string, OperationDeclaration<InventoryDatabase>>> {
  return {
    [INVENTORY_OP.categoryAdded]: {
      schemaVersion: 1,
      payload: categoryAddedPayload,
      scope: 'tenant',
      reversal: 'Taken off the list by inventory.category_edited with archived = true.',
      apply: categoryAddedApplier,
      rule: categoryAddedRule,
      permission: INVENTORY_PERMISSION.manageCategories,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_CATEGORY_ENTITY,
    },
    [INVENTORY_OP.categoryEdited]: {
      schemaVersion: 1,
      payload: categoryEditedPayload,
      scope: 'tenant',
      reversal: 'Reversed by another inventory.category_edited with the previous details.',
      apply: categoryEditedApplier,
      rule: categoryEditedRule,
      permission: INVENTORY_PERMISSION.manageCategories,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_CATEGORY_ENTITY,
      conflict: { key: 'inventory_category.details', severity: 'minor' },
    },
    [INVENTORY_OP.itemAdded]: {
      schemaVersion: 1,
      payload: itemAddedPayload,
      scope: 'tenant',
      reversal: 'Taken off the list by inventory.item_edited with archived = true.',
      apply: itemAddedApplier,
      rule: itemAddedRule,
      permission: INVENTORY_PERMISSION.manageItems,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_ITEM_ENTITY,
    },
    [INVENTORY_OP.itemEdited]: {
      schemaVersion: 1,
      payload: itemEditedPayload,
      scope: 'tenant',
      reversal: 'Reversed by another inventory.item_edited with the previous details.',
      apply: itemEditedApplier,
      rule: itemEditedRule,
      permission: INVENTORY_PERMISSION.manageItems,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_ITEM_ENTITY,
      conflict: { key: 'inventory_item.details', severity: 'minor' },
    },
    [INVENTORY_OP.stockCounted]: {
      schemaVersion: 1,
      payload: stockCountedPayload,
      reversal: 'Corrected by another count of the same part.',
      apply: stockCountedApplier,
      rule: stockCountedRule,
      permission: INVENTORY_PERMISSION.count,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.itemTaken]: {
      schemaVersion: 1,
      payload: itemTakenPayload,
      reversal: 'Reversed by inventory.item_put_back for the same use.',
      apply: itemTakenApplier,
      rule: itemTakenRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.itemPutBack]: {
      schemaVersion: 1,
      payload: itemPutBackPayload,
      reversal: 'Reversed by taking the part again with inventory.item_taken.',
      apply: itemPutBackApplier,
      rule: itemPutBackRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.stockReceived]: {
      schemaVersion: 1,
      payload: stockReceivedPayload,
      reversal: 'Corrected by a count, or later by a return to the supplier.',
      apply: stockReceivedApplier,
      rule: stockReceivedRule(sources),
      permission: INVENTORY_PERMISSION.receive,
      // Staff see stock arrive; what it cost travels apart, to owners only.
      read: INVENTORY_PERMISSION.read,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
  };
}
