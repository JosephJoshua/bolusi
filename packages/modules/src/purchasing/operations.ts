// The `purchasing` op types. Suppliers are tenant-scoped (one list for the business); orders and
// receipts are store-scoped. Payloads are `.strict()` and carry nulls rather than absent keys.
//
// Quantities only: what a part cost travels in its own op type, read by owners alone, so a store
// phone sees an order arrive without ever holding what it cost.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

import {
  orderCancelledApplier,
  orderDraftedApplier,
  orderEditedApplier,
  orderPlacedApplier,
  orderReceivedApplier,
  supplierAddedApplier,
  supplierEditedApplier,
} from './applier.js';
import {
  MAX_LINE_NAME,
  MAX_LINE_QTY,
  MAX_ORDER_LINES,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_NAME,
  MAX_SUPPLIER_PHONE,
  PURCHASING_OP,
  PURCHASING_ORDER_ENTITY,
  PURCHASING_PERMISSION,
  PURCHASING_RECEIPT_ENTITY,
  PURCHASING_SUPPLIER_ENTITY,
} from './constants.js';
import {
  orderCancelledRule,
  orderDraftedRule,
  orderEditedRule,
  orderPlacedRule,
  orderReceivedRule,
  supplierAddedRule,
  supplierEditedRule,
} from './rules.js';
import type { PurchasingDatabase } from './schema.js';

const zOptional = (max: number) => z.string().trim().min(1).max(max).nullable();
const zQty = z.number().int().min(1).max(MAX_LINE_QTY);

/** `PO-K7Q-0001`: the drafting device's code and its own counter. */
export const ORDER_NUMBER_PATTERN = /^PO-[0-9A-Z]{3}-\d{4,9}$/;

export const supplierDetailsPayload = z
  .object({
    name: z.string().trim().min(1).max(MAX_SUPPLIER_NAME),
    phone: zOptional(MAX_SUPPLIER_PHONE),
    note: zOptional(MAX_PURCHASING_NOTE),
  })
  .strict();

export const supplierEditedPayload = supplierDetailsPayload
  .extend({ archived: z.boolean() })
  .strict();

/** Each part once: a second line for the same part is the same order twice. */
const zOrderLines = z
  .array(
    z
      .object({
        itemId: zUuidV7,
        name: z.string().trim().min(1).max(MAX_LINE_NAME),
        qty: zQty,
      })
      .strict(),
  )
  .min(1)
  .max(MAX_ORDER_LINES)
  .refine((lines) => new Set(lines.map((line) => line.itemId)).size === lines.length, {
    message: 'a part twice',
  });

export const orderDetailsPayload = z
  .object({
    supplierId: zUuidV7,
    note: zOptional(MAX_PURCHASING_NOTE),
    lines: zOrderLines,
  })
  .strict();

export const orderDraftedPayload = orderDetailsPayload
  .extend({ orderNumber: z.string().regex(ORDER_NUMBER_PATTERN) })
  .strict();

export const orderPlacedPayload = z.object({}).strict();

export const orderCancelledPayload = z.object({ reason: zOptional(MAX_PURCHASING_NOTE) }).strict();

export const orderReceivedPayload = z
  .object({
    orderId: zUuidV7,
    note: zOptional(MAX_PURCHASING_NOTE),
    lines: z
      .array(z.object({ itemId: zUuidV7, qty: zQty }).strict())
      .min(1)
      .max(MAX_ORDER_LINES)
      .refine((lines) => new Set(lines.map((line) => line.itemId)).size === lines.length, {
        message: 'a part twice',
      }),
  })
  .strict();

const P = PURCHASING_PERMISSION;

export const PURCHASING_OPERATIONS: Readonly<
  Record<string, OperationDeclaration<PurchasingDatabase>>
> = {
  [PURCHASING_OP.supplierAdded]: {
    schemaVersion: 1,
    payload: supplierDetailsPayload,
    scope: 'tenant',
    reversal: 'Taken off the list by purchasing.supplier_edited with archived = true.',
    apply: supplierAddedApplier,
    rule: supplierAddedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_SUPPLIER_ENTITY,
  },
  [PURCHASING_OP.supplierEdited]: {
    schemaVersion: 1,
    payload: supplierEditedPayload,
    scope: 'tenant',
    reversal: 'Reversed by another purchasing.supplier_edited with the previous details.',
    apply: supplierEditedApplier,
    rule: supplierEditedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_SUPPLIER_ENTITY,
    conflict: { key: 'purchasing_supplier.details', severity: 'minor' },
  },
  [PURCHASING_OP.orderDrafted]: {
    schemaVersion: 1,
    payload: orderDraftedPayload,
    reversal: 'Withdrawn by purchasing.order_cancelled.',
    apply: orderDraftedApplier,
    rule: orderDraftedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_ORDER_ENTITY,
  },
  [PURCHASING_OP.orderEdited]: {
    schemaVersion: 1,
    payload: orderDetailsPayload,
    reversal: 'Reversed by another purchasing.order_edited with the previous lines.',
    apply: orderEditedApplier,
    rule: orderEditedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_ORDER_ENTITY,
    conflict: { key: 'purchasing_order.details', severity: 'minor' },
  },
  [PURCHASING_OP.orderPlaced]: {
    schemaVersion: 1,
    payload: orderPlacedPayload,
    reversal: 'Withdrawn by purchasing.order_cancelled; a placed order is not a draft again.',
    apply: orderPlacedApplier,
    rule: orderPlacedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_ORDER_ENTITY,
  },
  [PURCHASING_OP.orderCancelled]: {
    schemaVersion: 1,
    payload: orderCancelledPayload,
    reversal: 'Final: a new order is drafted instead. What already arrived stays received.',
    apply: orderCancelledApplier,
    rule: orderCancelledRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_ORDER_ENTITY,
  },
  [PURCHASING_OP.orderReceived]: {
    schemaVersion: 1,
    payload: orderReceivedPayload,
    reversal: 'Corrected by a stock count, or later by a return to the supplier.',
    apply: orderReceivedApplier,
    rule: orderReceivedRule,
    permission: P.buy,
    read: P.buy,
    entityType: PURCHASING_RECEIPT_ENTITY,
  },
};
