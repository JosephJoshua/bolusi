// The `money` op registry: payload schemas, reversal notes, appliers and rules.
//
// Records are store-scoped: money is taken, given and counted in one store, and every line carries
// that store even when it lands in a central account. Central accounts themselves are
// tenant-scoped, so every store's devices know them. Payloads are strict; money is integer IDR.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zMoneyIdr, zUuid } from '@bolusi/schemas';

import { accountSavedApplier, entryRecordedApplier, paymentVoidedApplier } from './applier.js';
import {
  CASH_MOVE_KINDS,
  MAX_ACCOUNT_NAME,
  MAX_AMOUNT,
  MAX_REASON,
  MAX_REFERENCE,
  MONEY_ACCOUNT_ENTITY,
  MONEY_ENTRY_ENTITY,
  MONEY_OP,
  MONEY_PERMISSION,
  PAYMENT_ACCOUNT_KINDS,
  REVENUE_ACCOUNTS,
} from './constants.js';
import { zDocument, type MoneyDocumentSources } from './documents.js';
import { accountSavedRule, centralAccountSavedRule, createMoneyRules } from './rules.js';
import type { MoneyDatabase } from './schema.js';

const zAmount = zMoneyIdr.min(1).max(MAX_AMOUNT);
const zReason = z.string().trim().min(1).max(MAX_REASON);
const zNote = z.string().trim().max(MAX_REASON);
const zReference = z.string().trim().min(1).max(MAX_REFERENCE).nullable();
/** `cash` (the store's drawer) or `account:<uuid>`. */
export const zAccountRef = z.union([
  z.literal('cash'),
  z.string().regex(/^account:[0-9a-f-]{36}$/),
]);

const accountFields = {
  kind: z.enum(PAYMENT_ACCOUNT_KINDS),
  name: z.string().trim().min(1).max(MAX_ACCOUNT_NAME),
  active: z.boolean(),
};

export const accountSavedPayload = z.object(accountFields).strict();
export const centralAccountSavedPayload = z
  .object({
    ...accountFields,
    /** The stores that use it; empty for every store. */
    storeIds: z.array(zUuid).max(500),
  })
  .strict();

export const chargeRecordedPayload = z
  .object({ document: zDocument, amount: zAmount, account: z.enum(REVENUE_ACCOUNTS) })
  .strict();

export const chargeReducedPayload = z
  .object({ document: zDocument, amount: zAmount, reason: zReason })
  .strict();

export const paymentReceivedPayload = z
  .object({
    document: zDocument,
    account: zAccountRef,
    amount: zAmount,
    reference: zReference,
    /** Cash handed over, when typed, so the slip can show the change. */
    tendered: zMoneyIdr.min(1).max(MAX_AMOUNT).nullable(),
  })
  .strict();

export const paymentVoidedPayload = z.object({ reason: zReason }).strict();

export const refundPaidPayload = z
  .object({
    document: zDocument,
    account: zAccountRef,
    amount: zAmount,
    reason: zReason,
    reference: zReference,
  })
  .strict();

export const cashMovedPayload = z
  .object({
    kind: z.enum(CASH_MOVE_KINDS),
    amount: zAmount,
    reason: zReason,
    /** The account a deposit went into; null for every other kind. */
    account: zAccountRef.nullable(),
  })
  .strict();

export const cashCountedPayload = z
  .object({ counted: zMoneyIdr.min(0).max(MAX_AMOUNT), note: zNote })
  .strict();

export const cashAdjustedPayload = z
  .object({
    /** More cash than the book (positive) or less (negative). */
    amount: zMoneyIdr
      .min(-MAX_AMOUNT)
      .max(MAX_AMOUNT)
      .refine((n) => n !== 0, { message: 'an adjustment changes something' }),
    countId: zUuid.nullable(),
    reason: zReason,
  })
  .strict();

const NOT_REVERSIBLE = 'Not reversible: money moved. A mistake is corrected by a new record.';

export function createMoneyOperations(
  sources: MoneyDocumentSources,
): Record<string, OperationDeclaration<MoneyDatabase>> {
  const rules = createMoneyRules(sources);
  const entry = { entityType: MONEY_ENTRY_ENTITY, apply: entryRecordedApplier } as const;
  return {
    [MONEY_OP.accountSaved]: {
      schemaVersion: 1,
      payload: accountSavedPayload,
      reversal: 'Reversed by saving the account again as it was; past payments keep naming it.',
      apply: accountSavedApplier,
      rule: accountSavedRule,
      permission: MONEY_PERMISSION.manageAccounts,
      entityType: MONEY_ACCOUNT_ENTITY,
    },
    [MONEY_OP.centralAccountSaved]: {
      schemaVersion: 1,
      payload: centralAccountSavedPayload,
      reversal: 'Reversed by saving the account again as it was; past payments keep naming it.',
      apply: accountSavedApplier,
      rule: centralAccountSavedRule,
      permission: MONEY_PERMISSION.manageCentralAccounts,
      entityType: MONEY_ACCOUNT_ENTITY,
      scope: 'tenant',
    },
    [MONEY_OP.chargeRecorded]: {
      ...entry,
      schemaVersion: 1,
      payload: chargeRecordedPayload,
      reversal: 'Lowered only by an owner with money.charge_reduced.',
      rule: rules.chargeRecordedRule,
      permission: MONEY_PERMISSION.receive,
    },
    [MONEY_OP.chargeReduced]: {
      ...entry,
      schemaVersion: 1,
      payload: chargeReducedPayload,
      reversal:
        'Not reversible: what the customer owes was lowered. Charging again is a new charge.',
      rule: rules.chargeReducedRule,
      permission: MONEY_PERMISSION.refund,
    },
    [MONEY_OP.paymentReceived]: {
      ...entry,
      schemaVersion: 1,
      payload: paymentReceivedPayload,
      reversal:
        'Cancelled by an owner with money.payment_voided, or given back with money.refund_paid.',
      rule: rules.paymentReceivedRule,
      permission: MONEY_PERMISSION.receive,
    },
    [MONEY_OP.paymentVoided]: {
      schemaVersion: 1,
      payload: paymentVoidedPayload,
      reversal: 'Not reversible: record the payment again if it was real.',
      apply: paymentVoidedApplier,
      rule: rules.paymentVoidedRule,
      permission: MONEY_PERMISSION.voidPayment,
      entityType: MONEY_ENTRY_ENTITY,
    },
    [MONEY_OP.refundPaid]: {
      ...entry,
      schemaVersion: 1,
      payload: refundPaidPayload,
      reversal: NOT_REVERSIBLE,
      rule: rules.refundPaidRule,
      permission: MONEY_PERMISSION.receive,
    },
    [MONEY_OP.cashMoved]: {
      ...entry,
      schemaVersion: 1,
      payload: cashMovedPayload,
      reversal: NOT_REVERSIBLE,
      rule: rules.cashMovedRule,
      permission: MONEY_PERMISSION.moveCash,
    },
    [MONEY_OP.cashCounted]: {
      ...entry,
      schemaVersion: 1,
      payload: cashCountedPayload,
      reversal: 'Not reversible: the drawer was counted. Count again for a new figure.',
      rule: rules.cashCountedRule,
      permission: MONEY_PERMISSION.countCash,
    },
    [MONEY_OP.cashAdjusted]: {
      ...entry,
      schemaVersion: 1,
      payload: cashAdjustedPayload,
      reversal: 'Reversed by an opposite money.cash_adjusted.',
      rule: rules.cashAdjustedRule,
      permission: MONEY_PERMISSION.adjustCash,
    },
  };
}
