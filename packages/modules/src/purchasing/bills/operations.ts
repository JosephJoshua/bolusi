// The bill op types. Store-scoped, and read only with "Tagihan supplier": a bill carries what parts
// cost to buy, so a store device holds orders and deliveries without their bills.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';

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
  PURCHASING_PERMISSION,
} from '../constants.js';
import type { PurchasingDatabase } from '../schema.js';
import { zOptionalPayloadText } from '../../shared/optional-text.js';
import { billEditedApplier, billRecordedApplier, billVoidedApplier } from './applier.js';
import { billEditedRule, billRecordedRule, billVoidedRule } from './rules.js';

/** `TG-K7Q-0001`: the recording device's code and its own counter. */
export const BILL_NUMBER_PATTERN = /^TG-[0-9A-Z]{3}-\d{4,9}$/;

/**
 * A day, as ms epoch at the start of that day where it was recorded: a nota dated 2020 to 2099,
 * due up to a year later. A day either side spans every time zone; enough to catch a mistyped year.
 */
export const zBillDay = z
  .number()
  .int()
  .min(Date.UTC(2019, 11, 31))
  .max(Date.UTC(2101, 0, 2));

/** Each part once: the same part twice is one line with both counts. */
const zBillLines = z
  .array(
    z
      .object({
        itemId: zUuidV7,
        name: z.string().trim().min(1).max(MAX_LINE_NAME),
        qty: z.number().int().min(1).max(MAX_LINE_QTY),
        unitPrice: z.number().int().min(0).max(MAX_UNIT_PRICE),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_ORDER_LINES)
  .refine((lines) => new Set(lines.map((line) => line.itemId)).size === lines.length, {
    message: 'a part twice',
  });

const billDetails = z
  .object({
    supplierId: zUuidV7,
    orderId: zUuidV7.nullable(),
    supplierRef: zOptionalPayloadText(MAX_SUPPLIER_REF),
    billedOn: zBillDay,
    dueOn: zBillDay.nullable(),
    charges: z.number().int().min(0).max(MAX_BILL_CHARGES),
    note: zOptionalPayloadText(MAX_PURCHASING_NOTE),
    lines: zBillLines,
  })
  .strict();

/** "Tempo" runs from the nota's date: never before it. */
const dueAfterBilled = (bill: { billedOn: number; dueOn: number | null }): boolean =>
  bill.dueOn === null || bill.dueOn >= bill.billedOn;
const dueIssue = { message: 'due before the bill date', path: ['dueOn'] };

export const billDetailsPayload = billDetails.refine(dueAfterBilled, dueIssue);

export const billRecordedPayload = billDetails
  .extend({ billNumber: z.string().regex(BILL_NUMBER_PATTERN) })
  .strict()
  .refine(dueAfterBilled, dueIssue);

export const billVoidedPayload = z
  .object({ reason: z.string().trim().min(1).max(MAX_PURCHASING_NOTE) })
  .strict();

const P = PURCHASING_PERMISSION;

export const BILL_OPERATIONS: Readonly<Record<string, OperationDeclaration<PurchasingDatabase>>> = {
  [PURCHASING_OP.billRecorded]: {
    schemaVersion: 1,
    payload: billRecordedPayload,
    reversal: 'Withdrawn by purchasing.bill_voided.',
    apply: billRecordedApplier,
    rule: billRecordedRule,
    permission: P.bills,
    read: P.bills,
    entityType: PURCHASING_BILL_ENTITY,
  },
  [PURCHASING_OP.billEdited]: {
    schemaVersion: 1,
    payload: billDetailsPayload,
    reversal: 'Reversed by another purchasing.bill_edited with the previous details.',
    apply: billEditedApplier,
    rule: billEditedRule,
    permission: P.bills,
    read: P.bills,
    entityType: PURCHASING_BILL_ENTITY,
    conflict: { key: 'purchasing_bill.details', severity: 'minor' },
  },
  [PURCHASING_OP.billVoided]: {
    schemaVersion: 1,
    payload: billVoidedPayload,
    reversal: 'Final: a bill entered by mistake is recorded again instead.',
    apply: billVoidedApplier,
    rule: billVoidedRule,
    permission: P.bills,
    read: P.bills,
    entityType: PURCHASING_BILL_ENTITY,
  },
};
