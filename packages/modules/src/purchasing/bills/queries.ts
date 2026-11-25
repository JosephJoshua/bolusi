// The bill queries: this store's bills, each with its total and, when it bills an order, how its
// lines compare with what was ordered and what arrived. Nothing here is stored: a delivery recorded
// later changes the comparison on the next read. Read only with "Tagihan supplier".
import { sql } from 'kysely';
import { z } from 'zod';

import type { QueryContext, QueryPage } from '@bolusi/core';

import { deviceCode } from '../../shared/device-code.js';
import { userNames } from '../../shared/user-names.js';
import { PURCHASING_PERMISSION, type BillStatus } from '../constants.js';
import { linesOf } from '../queries.js';
import type { PurchasingDatabase } from '../schema.js';

type Qctx = QueryContext<PurchasingDatabase>;

export interface BillRow {
  readonly id: string;
  readonly billNumber: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplierRef: string | null;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly billedOn: number;
  readonly dueOn: number | null;
  readonly status: BillStatus;
  /** Its parts plus its charges, whole rupiah. */
  readonly total: number;
}

export interface BillLineRow {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPrice: number;
  /** qty × unitPrice. */
  readonly amount: number;
  /** When it bills an order: how many were ordered, or null for a part not on it. */
  readonly ordered: number | null;
  /** When it bills an order: how many have arrived so far. */
  readonly received: number | null;
  /** How many the order's other open bills already bill. */
  readonly billedElsewhere: number;
}

export interface BillDetailRow extends BillRow {
  readonly charges: number;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: number;
  readonly voidedAt: number | null;
  readonly voidedByName: string | null;
  readonly voidReason: string | null;
  readonly lines: readonly BillLineRow[];
}

/**
 * How a bill's part compares with its order, or null when it matches or the bill has no order:
 * billed beyond what arrived (a nota ahead of its parts, or the supplier billing too many), or a
 * part that was never ordered. Shown for the owner to check; nothing is refused for it.
 */
export function billLineCheck(
  line: Pick<BillLineRow, 'qty' | 'ordered' | 'received' | 'billedElsewhere'>,
):
  { readonly kind: 'notOrdered' } | { readonly kind: 'notArrived'; readonly count: number } | null {
  if (line.received === null) return null;
  if (line.ordered === null) return { kind: 'notOrdered' };
  const ahead = line.qty + line.billedElsewhere - line.received;
  return ahead > 0 ? { kind: 'notArrived', count: Math.min(ahead, line.qty) } : null;
}

export function billTotal(
  lines: readonly { readonly qty: number; readonly unitPrice: number }[],
  charges: number,
): number {
  return lines.reduce((sum, line) => sum + line.qty * line.unitPrice, charges);
}

function storeBills(qctx: Qctx) {
  return qctx.db
    .selectFrom('purchasingBills as b')
    .innerJoin('purchasingSuppliers as s', 's.id', 'b.supplierId')
    .leftJoin('purchasingOrders as o', 'o.id', 'b.orderId')
    .select([
      'b.id',
      'b.billNumber',
      'b.supplierId',
      's.name as supplierName',
      'b.supplierRef',
      'b.orderId',
      'o.orderNumber',
      'b.billedOn',
      'b.dueOn',
      'b.charges',
      'b.status',
      'b.note',
      'b.createdBy',
      'b.createdAt',
      'b.voidedBy',
      'b.voidedAt',
      'b.voidReason',
    ])
    .where('b.tenantId', '=', qctx.tenantId)
    .where('b.storeId', '=', qctx.storeId);
}

type RawBill = Awaited<ReturnType<ReturnType<typeof storeBills>['execute']>>[number];

async function billLines(qctx: Qctx, billIds: readonly string[]) {
  if (billIds.length === 0) return [];
  return qctx.db
    .selectFrom('purchasingBillLines')
    .select(['billId', 'itemId', 'itemName', 'qty', 'unitPrice'])
    .where('tenantId', '=', qctx.tenantId)
    .where('billId', 'in', billIds)
    .orderBy('billId')
    .orderBy('position')
    .execute();
}

function toRow(raw: RawBill, total: number): BillRow {
  return {
    id: raw.id,
    billNumber: raw.billNumber,
    supplierId: raw.supplierId,
    supplierName: raw.supplierName,
    supplierRef: raw.supplierRef,
    orderId: raw.orderId,
    orderNumber: raw.orderNumber ?? null,
    billedOn: Number(raw.billedOn),
    dueOn: raw.dueOn === null ? null : Number(raw.dueOn),
    status: raw.status as BillStatus,
    total,
  };
}

// ── listBills ──────────────────────────────────────────────────────────────────────────────────

export const BILL_FILTERS = ['open', 'all'] as const;
export type BillFilter = (typeof BILL_FILTERS)[number];

export const listBillsInput = z
  .object({
    /** `open`: standing bills; `all` adds the void ones. */
    filter: z.enum(BILL_FILTERS).default('open'),
    /** Only one order's bills. */
    orderId: z.string().min(1).nullable().default(null),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export type ListBillsInput = z.input<typeof listBillsInput>;

/** Open bills by when they fall due (the soonest first, no date last); all of them newest first. */
export async function listBillsHandler(
  input: z.output<typeof listBillsInput>,
  qctx: Qctx,
): Promise<QueryPage<BillRow>> {
  let query = storeBills(qctx);
  if (input.filter === 'open') query = query.where('b.status', '=', 'open');
  if (input.orderId !== null) query = query.where('b.orderId', '=', input.orderId);
  const raws = await (
    input.filter === 'open'
      ? query
          .orderBy(sql`CASE WHEN b.due_on IS NULL THEN 1 ELSE 0 END`)
          .orderBy('b.dueOn')
          .orderBy('b.billedOn')
      : query.orderBy('b.billedOn', 'desc').orderBy('b.createdAt', 'desc')
  )
    // One past the page says whether another follows.
    .limit(input.limit + 1)
    .offset(input.offset)
    .execute();
  const more = raws.length > input.limit;
  if (more) raws.pop();
  const lines = await billLines(
    qctx,
    raws.map((raw) => raw.id),
  );
  const rows = raws.map((raw) =>
    toRow(
      raw,
      billTotal(
        lines.filter((line) => line.billId === raw.id),
        Number(raw.charges),
      ),
    ),
  );
  return { rows, nextCursor: more ? String(input.offset + input.limit) : null };
}

export const listBillsQuery = {
  name: 'listBills',
  permission: PURCHASING_PERMISSION.bills,
  input: listBillsInput,
  handler: listBillsHandler,
} as const;

// ── getBill ────────────────────────────────────────────────────────────────────────────────────

export const getBillInput = z.object({ billId: z.string().min(1) }).strict();
export type GetBillInput = z.input<typeof getBillInput>;

export async function getBillHandler(
  input: z.output<typeof getBillInput>,
  qctx: Qctx,
): Promise<QueryPage<BillDetailRow>> {
  const raw = await storeBills(qctx).where('b.id', '=', input.billId).executeTakeFirst();
  if (raw === undefined) return { rows: [], nextCursor: null };
  const lines = await billLines(qctx, [raw.id]);
  const order =
    raw.orderId === null ? undefined : (await linesOf(qctx, [raw.orderId])).get(raw.orderId);
  // What the order's other standing bills already bill, by part.
  const elsewhere = new Map<string, number>();
  if (raw.orderId !== null) {
    const others = await qctx.db
      .selectFrom('purchasingBillLines as l')
      .innerJoin('purchasingBills as b', 'b.id', 'l.billId')
      .select(['l.itemId', (eb) => eb.fn.sum<number | string>('l.qty').as('qty')])
      .where('b.tenantId', '=', qctx.tenantId)
      .where('b.orderId', '=', raw.orderId)
      .where('b.status', '=', 'open')
      .where('b.id', '!=', raw.id)
      .groupBy('l.itemId')
      .execute();
    for (const row of others) elsewhere.set(row.itemId, Number(row.qty));
  }
  const names = await userNames(
    qctx.db,
    [raw.createdBy, raw.voidedBy].filter((id): id is string => id !== null),
  );
  const charges = Number(raw.charges);
  const row: BillDetailRow = {
    ...toRow(raw, billTotal(lines, charges)),
    charges,
    note: raw.note,
    createdBy: raw.createdBy,
    createdByName: names.get(raw.createdBy) ?? null,
    createdAt: Number(raw.createdAt),
    voidedAt: raw.voidedAt === null ? null : Number(raw.voidedAt),
    voidedByName: raw.voidedBy === null ? null : (names.get(raw.voidedBy) ?? null),
    voidReason: raw.voidReason,
    lines: lines.map((line) => {
      const onOrder = order?.find((one) => one.itemId === line.itemId);
      return {
        itemId: line.itemId,
        name: line.itemName,
        qty: Number(line.qty),
        unitPrice: Number(line.unitPrice),
        amount: Number(line.qty) * Number(line.unitPrice),
        ordered: order === undefined ? null : (onOrder?.qty ?? null),
        received: order === undefined ? null : (onOrder?.received ?? 0),
        billedElsewhere: elsewhere.get(line.itemId) ?? 0,
      };
    }),
  };
  return { rows: [row], nextCursor: null };
}

export const getBillQuery = {
  name: 'getBill',
  permission: PURCHASING_PERMISSION.bills,
  input: getBillInput,
  handler: getBillHandler,
} as const;

// ── billsWithRef ───────────────────────────────────────────────────────────────────────────────

export const billsWithRefInput = z
  .object({ supplierId: z.string().min(1), supplierRef: z.string().trim().min(1) })
  .strict();

/** This store's standing bills with a supplier's nota number, whatever its case: a nota twice. */
export async function billsWithRefHandler(
  input: z.output<typeof billsWithRefInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly id: string; readonly billNumber: string }>> {
  const rows = await qctx.db
    .selectFrom('purchasingBills')
    .select(['id', 'billNumber'])
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where('supplierId', '=', input.supplierId)
    .where('status', '=', 'open')
    .where(sql<string>`lower(supplier_ref)`, '=', input.supplierRef.toLowerCase())
    .execute();
  return { rows, nextCursor: null };
}

export const billsWithRefQuery = {
  name: 'billsWithRef',
  permission: PURCHASING_PERMISSION.bills,
  input: billsWithRefInput,
  handler: billsWithRefHandler,
} as const;

// ── nextBillNumber ─────────────────────────────────────────────────────────────────────────────

export const nextBillNumberInput = z.object({ deviceId: z.string().min(1) }).strict();

/** The next `TG-<device code>-<counter>` for this device, as order numbers are minted. */
export async function nextBillNumberHandler(
  input: z.output<typeof nextBillNumberInput>,
  qctx: Qctx,
): Promise<QueryPage<{ readonly billNumber: string }>> {
  const prefix = `TG-${deviceCode(input.deviceId)}-`;
  const row = await qctx.db
    .selectFrom('purchasingBills')
    .select(
      sql<
        number | null
      >`MAX(CASE WHEN length(bill_number) BETWEEN 11 AND 16 AND substr(bill_number, 8) NOT GLOB '*[^0-9]*' THEN CAST(substr(bill_number, 8) AS INTEGER) END)`.as(
        'counter',
      ),
    )
    .where('tenantId', '=', qctx.tenantId)
    .where('storeId', '=', qctx.storeId)
    .where(sql<string>`substr(bill_number, 1, 7)`, '=', prefix)
    .executeTakeFirst();
  const highest = Number(row?.counter ?? 0);
  return {
    rows: [{ billNumber: `${prefix}${String(highest + 1).padStart(4, '0')}` }],
    nextCursor: null,
  };
}

export const nextBillNumberQuery = {
  name: 'nextBillNumber',
  permission: PURCHASING_PERMISSION.bills,
  input: nextBillNumberInput,
  handler: nextBillNumberHandler,
} as const;
