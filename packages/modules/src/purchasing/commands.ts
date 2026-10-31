// The `purchasing` commands: the only write path. Handlers compose op drafts; whether each may be
// recorded is its type's rule (rules.ts), run on the device before saving and on the server on push.
// Receiving writes the receipt and, next to it, the stock it brings in (inventory's own op), in one
// save: nothing listens for events.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import { stockReceivedOp } from '../inventory/commands.js';
import {
  MAX_LINE_NAME,
  MAX_LINE_QTY,
  MAX_ORDER_LINES,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_NAME,
  MAX_SUPPLIER_PHONE,
  PURCHASING_OP,
  PURCHASING_ORDER_ENTITY,
  PURCHASING_RECEIPT_ENTITY,
  PURCHASING_SUPPLIER_ENTITY,
} from './constants.js';
import {
  getOrderQuery,
  listSuppliersQuery,
  nextOrderNumberQuery,
  orderItemsQuery,
  type OrderDetailRow,
  type SupplierRow,
} from './queries.js';
import { zOptionalText } from '../shared/optional-text.js';
import { orderActions } from './order-form.js';

type OpDraft = ReturnType<CommandContext['op']>;

function invalid(field: string, issue: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { field, issue });
}

// ── suppliers ──────────────────────────────────────────────────────────────────────────────────

const zSupplierDetails = z
  .object({
    name: z.string().trim().min(1).max(MAX_SUPPLIER_NAME),
    phone: zOptionalText(MAX_SUPPLIER_PHONE),
    note: zOptionalText(MAX_PURCHASING_NOTE),
  })
  .strict();

export const addSupplierInput = zSupplierDetails;
export type AddSupplierInput = z.input<typeof addSupplierInput>;

async function suppliers(ctx: CommandContext): Promise<readonly SupplierRow[]> {
  return (await ctx.query(listSuppliersQuery, { text: '', includeArchived: true })).rows;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function addSupplierHandler(
  input: z.output<typeof addSupplierInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ supplierId: string }>> {
  // The same shop typed twice would split its orders over two names.
  if ((await suppliers(ctx)).some((row) => !row.archived && sameName(row.name, input.name))) {
    throw invalid('name', 'already on the list');
  }
  const supplierId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.supplierAdded,
        entityType: PURCHASING_SUPPLIER_ENTITY,
        entityId: supplierId,
        payload: input,
      }),
    ],
    result: { supplierId },
  };
}

export const editSupplierInput = zSupplierDetails
  .extend({ supplierId: z.string().min(1), archived: z.boolean() })
  .strict();
export type EditSupplierInput = z.input<typeof editSupplierInput>;

export async function editSupplierHandler(
  input: z.output<typeof editSupplierInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ supplierId: string }>> {
  const { supplierId, ...details } = input;
  const all = await suppliers(ctx);
  const current = all.find((row) => row.id === supplierId);
  if (current === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: PURCHASING_SUPPLIER_ENTITY,
      entityId: supplierId,
    });
  }
  if (
    current.name === details.name &&
    current.phone === details.phone &&
    current.note === details.note &&
    current.archived === details.archived
  ) {
    throw invalid('name', 'nothing changed');
  }
  if (
    !details.archived &&
    all.some((row) => row.id !== supplierId && !row.archived && sameName(row.name, details.name))
  ) {
    throw invalid('name', 'already on the list');
  }
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.supplierEdited,
        entityType: PURCHASING_SUPPLIER_ENTITY,
        entityId: supplierId,
        payload: details,
      }),
    ],
    result: { supplierId },
  };
}

// ── orders ─────────────────────────────────────────────────────────────────────────────────────

const zLines = z
  .array(
    z
      .object({ itemId: z.string().min(1), qty: z.number().int().min(1).max(MAX_LINE_QTY) })
      .strict(),
  )
  .min(1)
  .max(MAX_ORDER_LINES);

const zOrderDetails = z
  .object({
    supplierId: z.string().min(1),
    note: zOptionalText(MAX_PURCHASING_NOTE),
    lines: zLines,
  })
  .strict();

/**
 * The lines as the op carries them: each part once, named as the list names it now (what the
 * supplier is told). A part taken off the list is not ordered again.
 */
async function orderLines(ctx: CommandContext, lines: z.output<typeof zLines>) {
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
    throw invalid('lines', 'a part twice');
  }
  const items = new Map(
    (await ctx.query(orderItemsQuery, { itemIds: lines.map((line) => line.itemId) })).rows.map(
      (row) => [row.id, row],
    ),
  );
  return lines.map((line) => {
    const item = items.get(line.itemId);
    if (item === undefined) {
      throw new DomainError('ENTITY_NOT_FOUND', {
        entityType: 'inventory_item',
        entityId: line.itemId,
      });
    }
    if (item.archived) throw invalid('lines', 'archived part');
    return { itemId: line.itemId, name: item.name.slice(0, MAX_LINE_NAME), qty: line.qty };
  });
}

async function requireActiveSupplier(ctx: CommandContext, supplierId: string): Promise<void> {
  const supplier = (await suppliers(ctx)).find((row) => row.id === supplierId);
  if (supplier === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: PURCHASING_SUPPLIER_ENTITY,
      entityId: supplierId,
    });
  }
  if (supplier.archived) throw invalid('supplierId', 'archived');
}

async function loadOrder(ctx: CommandContext, orderId: string): Promise<OrderDetailRow> {
  const order = (await ctx.query(getOrderQuery, { orderId })).rows[0];
  if (order === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: PURCHASING_ORDER_ENTITY,
      entityId: orderId,
    });
  }
  return order;
}

function placeOp(ctx: CommandContext, orderId: string): OpDraft {
  return ctx.op({
    type: PURCHASING_OP.orderPlaced,
    entityType: PURCHASING_ORDER_ENTITY,
    entityId: orderId,
    payload: {},
  });
}

export const draftOrderInput = zOrderDetails
  .extend({
    /** Place it at once ("Pesan"), or keep it a draft to finish later. */
    place: z.boolean().default(false),
  })
  .strict();
export type DraftOrderInput = z.input<typeof draftOrderInput>;

export async function draftOrderHandler(
  input: z.output<typeof draftOrderInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ orderId: string; orderNumber: string }>> {
  await requireActiveSupplier(ctx, input.supplierId);
  const lines = await orderLines(ctx, input.lines);
  const { orderNumber } = (await ctx.query(nextOrderNumberQuery, { deviceId: ctx.deviceId }))
    .rows[0]!;
  const orderId = ctx.newId();
  const ops = [
    ctx.op({
      type: PURCHASING_OP.orderDrafted,
      entityType: PURCHASING_ORDER_ENTITY,
      entityId: orderId,
      payload: { orderNumber, supplierId: input.supplierId, note: input.note, lines },
    }),
  ];
  if (input.place) ops.push(placeOp(ctx, orderId));
  return { ops, result: { orderId, orderNumber } };
}

function requireDraft(order: OrderDetailRow): void {
  if (order.status !== 'draft') throw invalid('orderId', `order is ${order.status}`);
}

export const editOrderInput = zOrderDetails
  .extend({ orderId: z.string().min(1), place: z.boolean().default(false) })
  .strict();
export type EditOrderInput = z.input<typeof editOrderInput>;

/** Change a draft, and place it when asked. A draft saved unchanged and placed is just placed. */
export async function editOrderHandler(
  input: z.output<typeof editOrderInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ orderId: string }>> {
  const order = await loadOrder(ctx, input.orderId);
  requireDraft(order);
  const lines = await orderLines(ctx, input.lines);
  const unchanged =
    order.supplierId === input.supplierId &&
    order.note === input.note &&
    order.lines.length === lines.length &&
    order.lines.every((line, i) => line.itemId === lines[i]!.itemId && line.qty === lines[i]!.qty);
  if (unchanged && !input.place) throw invalid('lines', 'nothing changed');
  // A supplier archived since the draft was written is not ordered from.
  if (order.supplierId !== input.supplierId || input.place) {
    await requireActiveSupplier(ctx, input.supplierId);
  }
  const ops: OpDraft[] = [];
  if (!unchanged) {
    ops.push(
      ctx.op({
        type: PURCHASING_OP.orderEdited,
        entityType: PURCHASING_ORDER_ENTITY,
        entityId: order.id,
        payload: { supplierId: input.supplierId, note: input.note, lines },
      }),
    );
  }
  if (input.place) ops.push(placeOp(ctx, order.id));
  return { ops, result: { orderId: order.id } };
}

export const cancelOrderInput = z
  .object({ orderId: z.string().min(1), reason: zOptionalText(MAX_PURCHASING_NOTE) })
  .strict();
export type CancelOrderInput = z.input<typeof cancelOrderInput>;

/** Cancel an order (or drop a draft). What already arrived stays in stock; the rest is closed. */
export async function cancelOrderHandler(
  input: z.output<typeof cancelOrderInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ orderId: string }>> {
  const order = await loadOrder(ctx, input.orderId);
  if (order.status === 'cancelled') throw invalid('orderId', 'already cancelled');
  // Everything came: there is nothing left to stop waiting for.
  if (!orderActions(order.stage).includes('cancel')) throw invalid('orderId', 'nothing to come');
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.orderCancelled,
        entityType: PURCHASING_ORDER_ENTITY,
        entityId: order.id,
        payload: { reason: input.reason },
      }),
    ],
    result: { orderId: order.id },
  };
}

// ── receiving ──────────────────────────────────────────────────────────────────────────────────

export const receiveOrderInput = z
  .object({
    orderId: z.string().min(1),
    /** What arrived, per part; a part that did not come is left out or sent as 0. */
    lines: z
      .array(
        z
          .object({ itemId: z.string().min(1), qty: z.number().int().min(0).max(MAX_LINE_QTY) })
          .strict(),
      )
      .min(1)
      .max(MAX_ORDER_LINES),
    note: zOptionalText(MAX_PURCHASING_NOTE),
  })
  .strict();
export type ReceiveOrderInput = z.input<typeof receiveOrderInput>;

/**
 * Record what arrived on a placed order: the receipt, and each part into this store's stock. More
 * than was ordered is allowed (the supplier sent extra); the order then reads "Diterima lebih".
 */
export async function receiveOrderHandler(
  input: z.output<typeof receiveOrderInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ receiptId: string }>> {
  const order = await loadOrder(ctx, input.orderId);
  if (order.status !== 'ordered') throw invalid('orderId', `order is ${order.status}`);
  const arrived = input.lines.filter((line) => line.qty > 0);
  if (arrived.length === 0) throw invalid('lines', 'nothing arrived');
  if (new Set(arrived.map((line) => line.itemId)).size !== arrived.length) {
    throw invalid('lines', 'a part twice');
  }
  const onOrder = new Set(order.lines.map((line) => line.itemId));
  if (arrived.some((line) => !onOrder.has(line.itemId))) throw invalid('lines', 'not on the order');
  const receiptId = ctx.newId();
  const source = { kind: 'purchase_receipt' as const, id: receiptId, label: order.orderNumber };
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.orderReceived,
        entityType: PURCHASING_RECEIPT_ENTITY,
        entityId: receiptId,
        payload: { orderId: order.id, note: input.note, lines: arrived },
      }),
      ...arrived.map((line) =>
        stockReceivedOp(ctx, { itemId: line.itemId, qty: line.qty, source }),
      ),
    ],
    result: { receiptId },
  };
}
