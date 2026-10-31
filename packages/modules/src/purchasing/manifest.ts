// The `purchasing` module manifest: suppliers, orders to them, and receiving what arrives.
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import {
  purchasingOrderLinesTable,
  purchasingOrdersTable,
  purchasingReceiptLinesTable,
  purchasingReceiptsTable,
  purchasingSuppliersTable,
} from './applier.js';
import {
  addSupplierHandler,
  addSupplierInput,
  cancelOrderHandler,
  cancelOrderInput,
  draftOrderHandler,
  draftOrderInput,
  editOrderHandler,
  editOrderInput,
  editSupplierHandler,
  editSupplierInput,
  receiveOrderHandler,
  receiveOrderInput,
} from './commands.js';
import { PURCHASING_MODULE_ID, PURCHASING_PERMISSION, PURCHASING_TABLE } from './constants.js';
import { PURCHASING_OPERATIONS } from './operations.js';
import {
  getOrderQuery,
  listOrdersQuery,
  listSuppliersQuery,
  nextOrderNumberQuery,
  orderItemsQuery,
} from './queries.js';
import { PURCHASING_REFUSALS } from './rules.js';
import type { PurchasingDatabase } from './schema.js';

export const PURCHASING_PERMISSIONS = {
  [PURCHASING_PERMISSION.buy]: {
    scope: 'store',
    isDangerous: false,
    description:
      "Can keep the business's suppliers, order parts from them for the store and receive what arrives.",
  },
} as const;

const P = PURCHASING_PERMISSION;

export const purchasingModuleManifest = {
  id: PURCHASING_MODULE_ID,

  operations: PURCHASING_OPERATIONS,
  refusals: PURCHASING_REFUSALS.reasons,

  // DDL lives in the client and server migrations, as for inventory.
  projections: {
    tables: {
      [PURCHASING_TABLE.suppliers]: purchasingSuppliersTable,
      [PURCHASING_TABLE.orders]: purchasingOrdersTable,
      [PURCHASING_TABLE.orderLines]: purchasingOrderLinesTable,
      [PURCHASING_TABLE.receipts]: purchasingReceiptsTable,
      [PURCHASING_TABLE.receiptLines]: purchasingReceiptLinesTable,
    },
  },

  permissions: PURCHASING_PERMISSIONS,

  commands: {
    addSupplier: { permission: P.buy, input: addSupplierInput, handler: addSupplierHandler },
    editSupplier: { permission: P.buy, input: editSupplierInput, handler: editSupplierHandler },
    draftOrder: { permission: P.buy, input: draftOrderInput, handler: draftOrderHandler },
    editOrder: { permission: P.buy, input: editOrderInput, handler: editOrderHandler },
    cancelOrder: { permission: P.buy, input: cancelOrderInput, handler: cancelOrderHandler },
    receiveOrder: { permission: P.buy, input: receiveOrderInput, handler: receiveOrderHandler },
  },

  queries: {
    listSuppliers: listSuppliersQuery,
    listOrders: listOrdersQuery,
    getOrder: getOrderQuery,
    orderItems: orderItemsQuery,
    nextOrderNumber: nextOrderNumberQuery,
  },
} as const satisfies ModuleManifest<PurchasingDatabase>;

export type PurchasingModuleManifest = typeof purchasingModuleManifest;
export type PurchasingModule = ModuleDefinition<PurchasingDatabase, PurchasingModuleManifest>;

export const purchasingModule: PurchasingModule = defineModule<
  PurchasingDatabase,
  PurchasingModuleManifest
>(purchasingModuleManifest);
