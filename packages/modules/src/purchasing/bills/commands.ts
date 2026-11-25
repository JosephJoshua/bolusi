// The bill commands: record a supplier's nota as this store's bill, correct it, or void one entered by
// mistake. Whether each may be recorded is its op's rule (bills/rules.ts), run here before saving
// and on the server on push. What is paid on a bill is money's, not the bill's.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import {
  MAX_BILL_CHARGES,
  MAX_LINE_NAME,
  MAX_LINE_QTY,
  MAX_ORDER_LINES,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_REF,
  MAX_UNIT_PRICE,
  PURCHASING_BILL_ENTITY,
  PURCHASING_OP,
} from '../constants.js';
import { orderItemsQuery } from '../queries.js';
import { zOptionalText } from '../../shared/optional-text.js';
import {
  billsWithRefQuery,
  getBillQuery,
  nextBillNumberQuery,
  type BillDetailRow,
} from './queries.js';

function invalid(field: string, issue: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { field, issue });
}

/** A day as the screens pick it: midnight UTC of that date, as ms epoch. */
const zDay = z
  .number()
  .int()
  .min(Date.UTC(2020, 0, 1))
  .max(Date.UTC(2100, 0, 1));

const zBillDetails = z
  .object({
    supplierId: z.string().min(1),
    /** The order this nota bills, or null for one bought without an order in the app. */
    orderId: z.string().min(1).nullable().default(null),
    supplierRef: zOptionalText(MAX_SUPPLIER_REF),
    billedOn: zDay,
    /** When it must be paid ("tempo"); null when it is paid at once or in advance. */
    dueOn: zDay.nullable().default(null),
    /** Ongkir and other charges on the nota, whole rupiah. */
    charges: z.number().int().min(0).max(MAX_BILL_CHARGES).default(0),
    note: zOptionalText(MAX_PURCHASING_NOTE),
    lines: z
      .array(
        z
          .object({
            itemId: z.string().min(1),
            qty: z.number().int().min(1).max(MAX_LINE_QTY),
            unitPrice: z.number().int().min(0).max(MAX_UNIT_PRICE),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ORDER_LINES),
  })
  .strict();

type BillInput = z.output<typeof zBillDetails>;

/** The details as the op carries them: each part once, named as the parts list names it now. */
async function billPayload(ctx: CommandContext, input: BillInput) {
  if (input.dueOn !== null && input.dueOn < input.billedOn) {
    throw invalid('dueOn', 'due before the bill date');
  }
  const { lines } = input;
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
    throw invalid('lines', 'a part twice');
  }
  const items = new Map(
    (await ctx.query(orderItemsQuery, { itemIds: lines.map((line) => line.itemId) })).rows.map(
      (row) => [row.id, row],
    ),
  );
  return {
    supplierId: input.supplierId,
    orderId: input.orderId,
    supplierRef: input.supplierRef,
    billedOn: input.billedOn,
    dueOn: input.dueOn,
    charges: input.charges,
    note: input.note,
    // A part taken off the list since is still billed: it was bought before.
    lines: lines.map((line) => {
      const item = items.get(line.itemId);
      if (item === undefined) {
        throw new DomainError('ENTITY_NOT_FOUND', {
          entityType: 'inventory_item',
          entityId: line.itemId,
        });
      }
      return { ...line, name: item.name.slice(0, MAX_LINE_NAME) };
    }),
  };
}

/**
 * The same supplier's nota number on another standing bill is the same nota entered twice, which
 * would be owed and paid twice.
 */
async function requireNewNota(
  ctx: CommandContext,
  input: Pick<BillInput, 'supplierId' | 'supplierRef'>,
  billId: string | null,
): Promise<void> {
  if (input.supplierRef === null) return;
  const same = (
    await ctx.query(billsWithRefQuery, {
      supplierId: input.supplierId,
      supplierRef: input.supplierRef,
    })
  ).rows;
  if (same.some((bill) => bill.id !== billId)) {
    throw invalid('supplierRef', 'already recorded');
  }
}

async function loadBill(ctx: CommandContext, billId: string): Promise<BillDetailRow> {
  const bill = (await ctx.query(getBillQuery, { billId })).rows[0];
  if (bill === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: PURCHASING_BILL_ENTITY,
      entityId: billId,
    });
  }
  if (bill.status === 'void') throw invalid('billId', 'bill is void');
  return bill;
}

export const recordBillInput = zBillDetails;
export type RecordBillInput = z.input<typeof recordBillInput>;

export async function recordBillHandler(
  input: z.output<typeof recordBillInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ billId: string; billNumber: string }>> {
  const payload = await billPayload(ctx, input);
  await requireNewNota(ctx, input, null);
  const { billNumber } = (await ctx.query(nextBillNumberQuery, { deviceId: ctx.deviceId }))
    .rows[0]!;
  const billId = ctx.newId();
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.billRecorded,
        entityType: PURCHASING_BILL_ENTITY,
        entityId: billId,
        payload: { ...payload, billNumber },
      }),
    ],
    result: { billId, billNumber },
  };
}

export const editBillInput = zBillDetails.extend({ billId: z.string().min(1) }).strict();
export type EditBillInput = z.input<typeof editBillInput>;

export async function editBillHandler(
  input: z.output<typeof editBillInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ billId: string }>> {
  const bill = await loadBill(ctx, input.billId);
  const payload = await billPayload(ctx, input);
  const unchanged =
    bill.supplierId === payload.supplierId &&
    bill.orderId === payload.orderId &&
    bill.supplierRef === payload.supplierRef &&
    bill.billedOn === payload.billedOn &&
    bill.dueOn === payload.dueOn &&
    bill.charges === payload.charges &&
    bill.note === payload.note &&
    bill.lines.length === payload.lines.length &&
    bill.lines.every((line, i) => {
      const next = payload.lines[i]!;
      return (
        line.itemId === next.itemId && line.qty === next.qty && line.unitPrice === next.unitPrice
      );
    });
  if (unchanged) throw invalid('lines', 'nothing changed');
  await requireNewNota(ctx, input, bill.id);
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.billEdited,
        entityType: PURCHASING_BILL_ENTITY,
        entityId: bill.id,
        payload,
      }),
    ],
    result: { billId: bill.id },
  };
}

export const voidBillInput = z
  .object({
    billId: z.string().min(1),
    /** Why it is withdrawn: a void bill stays in the history with it. */
    reason: z.string().trim().min(1).max(MAX_PURCHASING_NOTE),
  })
  .strict();
export type VoidBillInput = z.input<typeof voidBillInput>;

export async function voidBillHandler(
  input: z.output<typeof voidBillInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ billId: string }>> {
  const bill = await loadBill(ctx, input.billId);
  return {
    ops: [
      ctx.op({
        type: PURCHASING_OP.billVoided,
        entityType: PURCHASING_BILL_ENTITY,
        entityId: bill.id,
        payload: { reason: input.reason },
      }),
    ],
    result: { billId: bill.id },
  };
}
