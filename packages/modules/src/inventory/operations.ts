// The `inventory` op types. Parts are tenant-scoped (every store sees one list); movements are
// store-scoped. Payloads are `.strict()` and carry nulls rather than absent keys.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import {
  partAddedApplier,
  partEditedApplier,
  partPutBackApplier,
  partTakenApplier,
  stockCountedApplier,
} from './applier.js';
import {
  INVENTORY_MOVEMENT_ENTITY,
  INVENTORY_OP,
  INVENTORY_PART_ENTITY,
  INVENTORY_PERMISSION,
  MAX_COUNTED_QTY,
  MAX_MOVEMENT_QTY,
  PART_USE_KINDS,
} from './constants.js';
import type { PartUseTargets } from './part-use.js';
import {
  partAddedRule,
  partEditedRule,
  partPutBackRule,
  partTakenRule,
  stockCountedRule,
} from './rules.js';
import type { InventoryDatabase } from './schema.js';

export const MAX_PART_NAME = 200;
export const MAX_PART_CODE = 60;
export const MAX_PART_FITS = 1000;
export const MAX_NOTE = 500;

const zName = z.string().trim().min(1).max(MAX_PART_NAME);
const zOptional = (max: number) => z.string().trim().min(1).max(max).nullable();

export const partDetailsPayload = z
  .object({ name: zName, code: zOptional(MAX_PART_CODE), fits: zOptional(MAX_PART_FITS) })
  .strict();

export const partAddedPayload = partDetailsPayload;

export const partEditedPayload = partDetailsPayload.extend({ archived: z.boolean() }).strict();

const zQty = z.number().int().min(1).max(MAX_MOVEMENT_QTY);

export const stockCountedPayload = z
  .object({
    partId: zUuidV7,
    counted: z.number().int().min(0).max(MAX_COUNTED_QTY),
    /** What the counting device showed: the movement is the difference, so takes it had not yet
     * seen still count once they sync. */
    expected: z.number().int().min(-MAX_COUNTED_QTY).max(MAX_COUNTED_QTY),
    note: zOptional(MAX_NOTE),
  })
  .strict();

export const zPartUse = z
  .object({ kind: z.enum(PART_USE_KINDS), id: zUuidV7, label: z.string().min(1).max(60) })
  .strict();

export const partTakenPayload = z.object({ partId: zUuidV7, qty: zQty, use: zPartUse }).strict();

export const partPutBackPayload = partTakenPayload;

/** The op declarations. Rules that check a part's use need the use targets the composition wires. */
export function inventoryOperations(
  targets: PartUseTargets,
): Readonly<Record<string, OperationDeclaration<InventoryDatabase>>> {
  return {
    [INVENTORY_OP.partAdded]: {
      schemaVersion: 1,
      payload: partAddedPayload,
      scope: 'tenant',
      reversal: 'Taken off the list by inventory.part_edited with archived = true.',
      apply: partAddedApplier,
      rule: partAddedRule,
      permission: INVENTORY_PERMISSION.manageParts,
      entityType: INVENTORY_PART_ENTITY,
    },
    [INVENTORY_OP.partEdited]: {
      schemaVersion: 1,
      payload: partEditedPayload,
      scope: 'tenant',
      reversal: 'Reversed by another inventory.part_edited with the previous details.',
      apply: partEditedApplier,
      rule: partEditedRule,
      permission: INVENTORY_PERMISSION.manageParts,
      entityType: INVENTORY_PART_ENTITY,
      conflict: { key: 'inventory_part.details', severity: 'minor' },
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
    [INVENTORY_OP.partTaken]: {
      schemaVersion: 1,
      payload: partTakenPayload,
      reversal: 'Reversed by inventory.part_put_back for the same use.',
      apply: partTakenApplier,
      rule: partTakenRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
    [INVENTORY_OP.partPutBack]: {
      schemaVersion: 1,
      payload: partPutBackPayload,
      reversal: 'Reversed by taking the part again with inventory.part_taken.',
      apply: partPutBackApplier,
      rule: partPutBackRule(targets),
      permission: INVENTORY_PERMISSION.useParts,
      entityType: INVENTORY_MOVEMENT_ENTITY,
    },
  };
}
