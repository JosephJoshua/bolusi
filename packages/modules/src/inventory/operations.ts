// The `inventory` op types. Parts are tenant-scoped (every store sees one list); movements are
// store-scoped. Payloads are `.strict()` and carry nulls rather than absent keys.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import {
  itemAddedApplier,
  itemEditedApplier,
  itemPutBackApplier,
  itemTakenApplier,
  stockCountedApplier,
} from './applier.js';
import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  MAX_PART_FITS,
  INVENTORY_ITEM_ENTITY,
  INVENTORY_PERMISSION,
  MAX_COUNTED_QTY,
  MAX_MOVEMENT_QTY,
  PART_USE_KINDS,
} from './constants.js';
import type { PartUseTargets } from './part-use.js';
import {
  itemAddedRule,
  itemEditedRule,
  itemPutBackRule,
  itemTakenRule,
  stockCountedRule,
} from './rules.js';
import type { InventoryDatabase } from './schema.js';

export const MAX_PART_NAME = 200;
export const MAX_PART_CODE = 60;
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
    code: zOptional(MAX_PART_CODE),
    fits: z.array(zPartFit).max(MAX_PART_FITS),
  })
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

/** The op declarations. Rules that check a part's use need the use targets the composition wires. */
export function inventoryOperations(
  targets: PartUseTargets,
): Readonly<Record<string, OperationDeclaration<InventoryDatabase>>> {
  return {
    [INVENTORY_OP.itemAdded]: {
      schemaVersion: 1,
      payload: itemAddedPayload,
      scope: 'tenant',
      reversal: 'Taken off the list by inventory.item_edited with archived = true.',
      apply: itemAddedApplier,
      rule: itemAddedRule,
      permission: INVENTORY_PERMISSION.manageItems,
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
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.itemTaken]: {
      schemaVersion: 1,
      payload: itemTakenPayload,
      reversal: 'Reversed by inventory.item_put_back for the same use.',
      apply: itemTakenApplier,
      rule: itemTakenRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.itemPutBack]: {
      schemaVersion: 1,
      payload: itemPutBackPayload,
      reversal: 'Reversed by taking the part again with inventory.item_taken.',
      apply: itemPutBackApplier,
      rule: itemPutBackRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
  };
}
