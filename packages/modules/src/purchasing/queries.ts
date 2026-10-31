// The `purchasing` queries. Suppliers are read across the tenant; orders are always this store's.
// Every read is scoped to the runtime-minted tenant and store.
//
// What an order has received is the sum of its receipts, read here, never stored on the order.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { normalizeText, type QueryContext, type QueryPage } from '@bolusi/core';

import type { InventoryDatabase } from '../inventory/schema.js';
import { deviceCode } from '../shared/device-code.js';
import { userNames } from '../shared/user-names.js';
import { PURCHASING_PERMISSION, type OrderStage, type OrderStatus } from './constants.js';
import type { PurchasingDatabase } from './schema.js';

type Qctx = QueryContext<PurchasingDatabase>;

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

export interface SupplierRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly note: string | null;
  readonly archived: boolean;
}

export interface OrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly status: OrderStatus;
  readonly stage: OrderStage;
  /** Parts on it, and how many of each were ordered and have arrived, summed. */
  readonly lineCount: number;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly createdAt: number;
  readonly orderedAt: number | null;
}

export interface OrderLineRow {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  readonly received: number;
}

export interface ReceiptRow {
  readonly id: string;
  readonly at: number;
  readonly userId: string;
  readonly userName: string | null;
  readonly note: string | null;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
  }[];
}

export interface OrderDetailRow extends OrderRow {
  readonly supplierPhone: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly cancelledAt: number | null;
  readonly cancelReason: string | null;
  readonly lines: readonly OrderLineRow[];
  /** Newest first. */
  readonly receipts: readonly ReceiptRow[];
}

/** How an order reads, from what it is and what has arrived on each of its lines. */
export function orderStage(
  status: OrderStatus,
  lines: readonly { readonly qty: number; readonly received: number }[],
): OrderStage {
  if (status === 'draft' || status === 'cancelled') return status;
  if (lines.every((line) => line.received === 0)) return 'ordered';
  // Anything still to come keeps it open, even when another line came over.
  if (lines.some((line) => line.received < line.qty)) return 'partial';
  return lines.some((line) => line.received > line.qty) ? 'over' : 'received';
}

/** What is still to come on each line: ordered minus arrived, never below zero. */
export function stillToCome(line: Pick<OrderLineRow, 'qty' | 'received'>): number {
  return Math.max(0, line.qty - line.received);
}

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────

function storeOrders(qctx: Qctx) {
  return qctx.db
    .selectFrom('purchasingOrders as o')
    .innerJoin('purchasingSuppliers as s', 's.id', 'o.supplierId')
    .select([
      'o.id',
      'o.orderNumber',
      'o.supplierId',
      's.name as supplierName',
      's.phone as supplierPhone',
      'o.status',
      'o.note',
      'o.createdBy',
      'o.createdAt',
      'o.orderedAt',
      'o.cancelledAt',
      'o.cancelReason',
    ])
    .where('o.tenantId', '=', qctx.tenantId)
    .where('o.storeId', '=', qctx.storeId);
}

/** Each order's lines with what has arrived on each, by order id. */
async function linesOf(
  qctx: Qctx,
  orderIds: readonly string[],
): Promise<Map<string, OrderLineRow[]>> {
  const byOrder = new Map<string, OrderLineRow[]>();
  if (orderIds.length === 0) return byOrder;
  const lines = await qctx.db
    .selectFrom('purchasingOrderLines')
    .select(['orderId', 'itemId', 'itemName', 'qty'])
    .where('tenantId', '=', qctx.tenantId)
    .where('orderId', 'in', orderIds)
    .orderBy('orderId')
    .orderBy('position')
    .execute();
  const received = await qctx.db
    .selectFrom('purchasingReceiptLines')
    .select(['orderId', 'itemId', (eb) => eb.fn.sum<number | string>('qty').as('received')])
    .where('tenantId', '=', qctx.tenantId)
    .where('orderId', 'in', orderIds)
    .groupBy(['orderId', 'itemId'])
    .execute();
  const arrived = new Map(
    received.map((row) => [`${row.orderId}:${row.itemId}`, Number(row.received)]),
  );
  for (const line of lines) {
    const list = byOrder.get(line.orderId) ?? [];
    list.push({
      itemId: line.itemId,
      name: line.itemName,
      qty: Number(line.qty),
      received: arrived.get(`${line.orderId}:${line.itemId}`) ?? 0,
    });
    byOrder.set(line.orderId, list);
  }
  return byOrder;
}

type RawOrder = Awaited<ReturnType<ReturnType<typeof storeOrders>['execute']>>[number];

function toOrder(row: RawOrder, lines: readonly OrderLineRow[]): OrderRow {
  const status = row.status as OrderStatus;
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    status,
    stage: orderStage(status, lines),
    lineCount: lines.length,
    orderedQty: lines.reduce((sum, line) => sum + line.qty, 0),
    receivedQty: lines.reduce((sum, line) => sum + line.received, 0),
    createdAt: Number(row.createdAt),
    orderedAt: row.orderedAt === null ? null : Number(row.orderedAt),
  };
}

// ── listSuppliers ──────────────────────────────────────────────────────────────────────────────

export const listSuppliersInput = z
  .object({
    text: z.string().trim().max(120).default(''),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export type ListSuppliersInput = z.input<typeof listSuppliersInput>;

/** The business's suppliers by name; `text` narrows by name or number. */
export async function listSuppliersHandler(
  input: z.output<typeof listSuppliersInput>,
  qctx: Qctx,
): Promise<QueryPage<SupplierRow>> {
  let query = qctx.db
    .selectFrom('purchasingSuppliers')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId);
  if (!input.includeArchived) query = query.where('archived', '=', 0);
  const rows = (await query.execute()).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    note: row.note,
    archived: Number(row.archived) === 1,
  }));
  const wanted = normalizeText(input.text);
  const digits = input.text.replace(/\D/g, '');
  return {
    rows: rows
      .filter(
        (row) =>
          wanted === '' ||
          normalizeText(row.name).includes(wanted) ||
          (digits !== '' && (row.phone ?? '').replace(/\D/g, '').includes(digits)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'id')),
    nextCursor: null,
  };
}

export const listSuppliersQuery = {
  name: 'listSuppliers',
  permission: PURCHASING_PERMISSION.buy,
  input: listSuppliersInput,
  handler: listSuppliersHandler,
} as const;

// ── listOrders ─────────────────────────────────────────────────────────────────────────────────

/** `open`: drafts and orders still waiting on parts; `done`: all in, or cancelled. */
export const ORDER_FILTERS = ['open', 'done'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

const OPEN_STAGES: ReadonlySet<OrderStage> = new Set(['draft', 'ordered', 'partial']);

export const listOrdersInput = z
  .object({
    filter: z.enum(ORDER_FILTERS).default('open'),
    supplierId: z.string().min(1).nullable().default(null),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ListOrdersInput = z.input<typeof listOrdersInput>;

/**
 * This store's orders, newest first. Open ones are drafts and orders with parts still to come; an
 * order that received more than it asked for is done (the owner sees it flagged on the order).
 */
export async function listOrdersHandler(
  input: z.output<typeof listOrdersInput>,
  qctx: Qctx,
): Promise<QueryPage<OrderRow>> {
  let query = storeOrders(qctx);
  if (input.supplierId !== null) query = query.where('o.supplierId', '=', input.supplierId);
  // Drafts and cancelled orders are decided by status alone; placed ones need their receipts.
  query =
    input.filter === 'open'
      ? query.where('o.status', 'in', ['draft', 'ordered'])
      : query.where('o.status', 'in', ['ordered', 'cancelled']);
  const raw = await query.orderBy('o.createdAt', 'desc').orderBy('o.id', 'desc').execute();
  const lines = await linesOf(
    qctx,
    raw.map((row) => row.id),
  );
  const orders = raw
    .map((row) => toOrder(row, lines.get(row.id) ?? []))
    .filter((order) => OPEN_STAGES.has(order.stage) === (input.filter === 'open'));
  const page = orders.slice(input.offset, input.offset + input.limit);
  const next = input.offset + input.limit;
  return { rows: page, nextCursor: next < orders.length ? String(next) : null };
}

export const listOrdersQuery = {
  name: 'listOrders',
  permission: PURCHASING_PERMISSION.buy,
  input: listOrdersInput,
  handler: listOrdersHandler,
} as const;

// ── getOrder ───────────────────────────────────────────────────────────────────────────────────

export const getOrderInput = z.object({ orderId: z.string().min(1) }).strict();
export type GetOrderInput = z.input<typeof getOrderInput>;

export async function getOrderHandler(
  input: z.output<typeof getOrderInput>,
  qctx: Qctx,
): Promise<QueryPage<OrderDetailRow>> {
  const row = await storeOrders(qctx).where('o.id', '=', input.orderId).executeTakeFirst();
  if (row === undefined) return { rows: [], nextCursor: null };
  const lines = (await linesOf(qctx, [row.id])).get(row.id) ?? [];
  const names = new Map(lines.map((line) => [line.itemId, line.name]));
  const receipts = await qctx.db
    .selectFrom('purchasingReceipts')
    .selectAll()
    .where('tenantId', '=', qctx.tenantId)
    .where('orderId', '=', row.id)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const receiptLines =
    receipts.length === 0
      ? []
      : await qctx.db
          .selectFrom('purchasingReceiptLines')
          .select(['receiptId', 'itemId', 'qty'])
          .where('tenantId', '=', qctx.tenantId)
          .where('orderId', '=', row.id)
          .orderBy('receiptId')
          .orderBy('position')
          .execute();
  const people = await userNames(qctx.db, [row.createdBy, ...receipts.map((r) => r.userId)]);
  return {
    rows: [
      {
        ...toOrder(row, lines),
        supplierPhone: row.supplierPhone,
        note: row.note,
        createdBy: row.createdBy,
        createdByName: people.get(row.createdBy) ?? null,
        cancelledAt: row.cancelledAt === null ? null : Number(row.cancelledAt),
        cancelReason: row.cancelReason,
        lines,
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          at: Number(receipt.at),
          userId: receipt.userId,
          userName: people.get(receipt.userId) ?? null,
          note: receipt.note,
          lines: receiptLines
            .filter((line) => line.receiptId === receipt.id)
            .map((line) => ({
              itemId: line.itemId,
              name: names.get(line.itemId) ?? '',
              qty: Number(line.qty),
            })),
        })),
      },
    ],
    nextCursor: null,
  };
}

export const getOrderQuery = {
  name: 'getOrder',
  permission: PURCHASING_PERMISSION.buy,
  input: getOrderInput,
  handler: getOrderHandler,
} as const;

// ── orderItems (the commands' read of the parts list) ─────────────────────────────────────────

export const orderItemsInput = z.object({ itemIds: z.array(z.string().min(1)).max(500) }).strict();

/** The parts an order names, from the business's list: what each is called now. */
export async function orderItemsHandler(
  input: z.output<typeof orderItemsInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly id: string; readonly name: string; readonly archived: boolean }>> {
  if (input.itemIds.length === 0) return { rows: [], nextCursor: null };
  const rows = await (qctx.db as unknown as Kysely<InventoryDatabase>)
    .selectFrom('inventoryItems')
    .select(['id', 'name', 'archived'])
    .where('tenantId', '=', qctx.tenantId)
    .where('id', 'in', input.itemIds)
    .execute();
  return {
    rows: rows.map((row) => ({ id: row.id, name: row.name, archived: Number(row.archived) === 1 })),
    nextCursor: null,
  };
}

export const orderItemsQuery = {
  name: 'orderItems',
  permission: PURCHASING_PERMISSION.buy,
  input: orderItemsInput,
  handler: orderItemsHandler,
} as const;

// ── nextOrderNumber ────────────────────────────────────────────────────────────────────────────

export const nextOrderNumberInput = z.object({ deviceId: z.string().min(1) }).strict();

/**
 * The next `PO-<device code>-<counter>` for this device: one past the highest this store has with
 * the code, so two devices sharing a code still avoid a duplicate once they have synced.
 */
export async function nextOrderNumberHandler(
  input: z.output<typeof nextOrderNumberInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly orderNumber: string }>> {
  const prefix = `PO-${deviceCode(input.deviceId)}-`;
  const rows = await qctx.db
    .selectFrom('purchasingOrders')
    .select('orderNumber')
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('orderNumber', 'like', `${prefix}%`)
    .execute();
  const highest = rows.reduce((max, row) => {
    const counter = Number(row.orderNumber.slice(prefix.length));
    return Number.isSafeInteger(counter) && counter > max ? counter : max;
  }, 0);
  return {
    rows: [{ orderNumber: `${prefix}${String(highest + 1).padStart(4, '0')}` }],
    nextCursor: null,
  };
}

export const nextOrderNumberQuery = {
  name: 'nextOrderNumber',
  permission: PURCHASING_PERMISSION.buy,
  input: nextOrderNumberInput,
  handler: nextOrderNumberHandler,
} as const;
