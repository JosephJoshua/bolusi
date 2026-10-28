// The `inventory` module manifest: the business's parts list and each store's stock.
//
// Built by a function because the take and put-back rules check each use through the module that
// owns it (part-use.ts). The composition root (`@bolusi/modules`) builds the one instance every app
// registers, with repair's check for servisan.
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import { inventoryMovementsTable, inventoryItemFitsTable, inventoryItemsTable } from './applier.js';
import {
  addItemHandler,
  addItemInput,
  countStockHandler,
  countStockInput,
  editItemHandler,
  editItemInput,
  putBackPartHandler,
  takePartHandler,
  usePartInput,
} from './commands.js';
import { INVENTORY_MODULE_ID, INVENTORY_PERMISSION, INVENTORY_TABLE } from './constants.js';
import { inventoryOperations } from './operations.js';
import type { PartUseTargets } from './part-use.js';
import {
  countBelowZeroQuery,
  getItemQuery,
  listItemsQuery,
  itemsFittingQuery,
  partsForUseQuery,
} from './queries.js';
import { INVENTORY_REFUSALS } from './rules.js';
import type { InventoryDatabase } from './schema.js';

export const INVENTORY_PERMISSIONS = {
  [INVENTORY_PERMISSION.read]: {
    scope: 'store',
    isDangerous: false,
    description: 'Can see the parts list and how many of each part the store has.',
  },
  [INVENTORY_PERMISSION.manageItems]: {
    scope: 'store',
    isDangerous: false,
    description:
      "Can add items (spareparts, and later accessories and other goods) to the business's list and edit them.",
  },
  [INVENTORY_PERMISSION.count]: {
    scope: 'store',
    // A count sets what the store has, so a wrong one could hide parts that went missing.
    isDangerous: true,
    description: 'Can set how many of each part the store has, from a count.',
  },
  [INVENTORY_PERMISSION.useParts]: {
    scope: 'store',
    isDangerous: false,
    description: 'Can take parts for a servisan being worked on and put unused ones back.',
  },
  [INVENTORY_PERMISSION.correctUse]: {
    scope: 'store',
    isDangerous: true,
    description:
      'Can take or put back parts on a servisan that is no longer being worked on, to correct it.',
  },
} as const;

export function inventoryModuleManifest(targets: PartUseTargets) {
  return {
    id: INVENTORY_MODULE_ID,

    operations: inventoryOperations(targets),
    refusals: INVENTORY_REFUSALS.reasons,

    // DDL lives in the client and server migrations, as for repair.
    projections: {
      tables: {
        [INVENTORY_TABLE.items]: inventoryItemsTable,
        [INVENTORY_TABLE.movements]: inventoryMovementsTable,
        [INVENTORY_TABLE.fits]: inventoryItemFitsTable,
      },
    },

    permissions: INVENTORY_PERMISSIONS,

    commands: {
      addItem: {
        permission: INVENTORY_PERMISSION.manageItems,
        input: addItemInput,
        handler: addItemHandler,
      },
      editItem: {
        permission: INVENTORY_PERMISSION.manageItems,
        input: editItemInput,
        handler: editItemHandler,
      },
      countStock: {
        permission: INVENTORY_PERMISSION.count,
        input: countStockInput,
        handler: countStockHandler,
      },
      takePart: {
        permission: INVENTORY_PERMISSION.useParts,
        input: usePartInput,
        handler: takePartHandler,
      },
      putBackPart: {
        permission: INVENTORY_PERMISSION.useParts,
        input: usePartInput,
        handler: putBackPartHandler,
      },
    },

    queries: {
      listItems: listItemsQuery,
      countBelowZero: countBelowZeroQuery,
      getItem: getItemQuery,
      partsForUse: partsForUseQuery,
      itemsFitting: itemsFittingQuery,
    },
  } as const satisfies ModuleManifest<InventoryDatabase>;
}

export type InventoryModuleManifest = ReturnType<typeof inventoryModuleManifest>;
export type InventoryModule = ModuleDefinition<InventoryDatabase, InventoryModuleManifest>;

export function defineInventoryModule(targets: PartUseTargets): InventoryModule {
  return defineModule<InventoryDatabase, InventoryModuleManifest>(inventoryModuleManifest(targets));
}
