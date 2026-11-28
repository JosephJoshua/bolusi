// The `pay` op types. Store-scoped. Kasbon is read with "Kasbon" (`pay.advances`); salaries,
// commission and payouts with `pay.read`, the owners' by default, so a store device holds none of
// it while staff work there. Every change is an owner's or a manager's decision.
import { z } from 'zod';

import type { OperationDeclaration } from '@bolusi/core';
import { zUuid } from '@bolusi/schemas';

import { zOptionalPayloadText } from '../shared/optional-text.js';
import {
  advanceGrantedApplier,
  advanceSettledApplier,
  advanceVoidedApplier,
  commissionAdjustedApplier,
  paidApplier,
  payoutVoidedApplier,
  repaymentVoidedApplier,
  storeCommissionSetApplier,
  termsSetApplier,
} from './applier.js';
import {
  MAX_COMMISSION_PERCENT,
  MAX_PAY_AMOUNT,
  MAX_PAY_NOTE,
  MONTH_PATTERN,
  PAY_ADJUSTMENT_ENTITY,
  PAY_ADVANCE_ENTITY,
  PAY_EMPLOYEE_ENTITY,
  PAY_OP,
  PAY_PAYOUT_ENTITY,
  PAY_PERMISSION,
  PAY_REPAYMENT_ENTITY,
  PAY_STORE_ENTITY,
  SALARY_REPAYMENT,
  WRITTEN_OFF,
} from './constants.js';
import {
  advanceGrantedRule,
  advanceSettledRule,
  advanceVoidedRule,
  commissionAdjustedRule,
  paidRule,
  payoutVoidedRule,
  repaymentVoidedRule,
  storeCommissionSetRule,
  termsSetRule,
} from './rules.js';
import type { PayDatabase } from './schema.js';

/** The drawer, or a store account. */
export const zPayAccount = z.union([
  z.literal('cash'),
  z.string().regex(/^account:[0-9a-f-]{36}$/),
]);
const zAmount = z.number().int().min(1).max(MAX_PAY_AMOUNT);
const zPercent = z.number().int().min(1).max(MAX_COMMISSION_PERCENT);
const zReason = z.string().trim().min(1).max(MAX_PAY_NOTE);

export const termsSetPayload = z
  .object({
    salary: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    /** Their own rate, or null for the store's. */
    commissionPercent: zPercent.nullable(),
  })
  .strict();

export const storeCommissionSetPayload = z
  .object({ commissionPercent: zPercent.nullable() })
  .strict();

export const advanceGrantedPayload = z
  .object({
    userId: zUuid,
    amount: zAmount,
    account: zPayAccount,
    reason: zReason,
    installment: zAmount,
  })
  .strict();

export const advanceSettledPayload = z
  .object({
    userId: zUuid,
    amount: zAmount,
    via: z.union([zPayAccount, z.literal(SALARY_REPAYMENT), z.literal(WRITTEN_OFF)]),
    payoutId: zUuid.nullable(),
    note: zOptionalPayloadText(MAX_PAY_NOTE),
  })
  .strict();

export const paidPayload = z
  .object({
    userId: zUuid,
    month: z.string().regex(MONTH_PATTERN),
    salary: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    commission: z.number().int().min(-MAX_PAY_AMOUNT).max(MAX_PAY_AMOUNT),
    deduction: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    repaymentId: zUuid.nullable(),
    paid: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    account: zPayAccount,
    note: zOptionalPayloadText(MAX_PAY_NOTE),
  })
  .strict();

export const commissionAdjustedPayload = z
  .object({
    userId: zUuid,
    amount: z.number().int().min(-MAX_PAY_AMOUNT).max(MAX_PAY_AMOUNT),
    reason: zReason,
  })
  .strict();

export const voidedPayload = z.object({ reason: zReason }).strict();

const P = PAY_PERMISSION;

export const PAY_OPERATIONS: Readonly<Record<string, OperationDeclaration<PayDatabase>>> = {
  [PAY_OP.termsSet]: {
    schemaVersion: 1,
    payload: termsSetPayload,
    reversal: 'Superseded by the next pay.terms_set.',
    apply: termsSetApplier,
    rule: termsSetRule,
    permission: P.manage,
    read: P.read,
    entityType: PAY_EMPLOYEE_ENTITY,
  },
  [PAY_OP.storeCommissionSet]: {
    schemaVersion: 1,
    payload: storeCommissionSetPayload,
    reversal: 'Superseded by the next pay.store_commission_set.',
    apply: storeCommissionSetApplier,
    rule: storeCommissionSetRule,
    permission: P.manage,
    read: P.read,
    entityType: PAY_STORE_ENTITY,
  },
  [PAY_OP.advanceGranted]: {
    schemaVersion: 1,
    payload: advanceGrantedPayload,
    reversal: 'Cancelled by pay.advance_voided.',
    apply: advanceGrantedApplier,
    rule: advanceGrantedRule,
    permission: P.advances,
    read: P.advances,
    entityType: PAY_ADVANCE_ENTITY,
  },
  [PAY_OP.advanceVoided]: {
    schemaVersion: 1,
    payload: voidedPayload,
    reversal: 'Final: a kasbon cancelled by mistake is given again.',
    apply: advanceVoidedApplier,
    rule: advanceVoidedRule,
    permission: P.manage,
    read: P.advances,
    entityType: PAY_ADVANCE_ENTITY,
  },
  [PAY_OP.advanceSettled]: {
    schemaVersion: 1,
    payload: advanceSettledPayload,
    reversal: 'Cancelled by pay.repayment_voided.',
    apply: advanceSettledApplier,
    rule: advanceSettledRule,
    permission: P.advances,
    read: P.advances,
    entityType: PAY_REPAYMENT_ENTITY,
  },
  [PAY_OP.repaymentVoided]: {
    schemaVersion: 1,
    payload: voidedPayload,
    reversal: 'Final: a repayment cancelled by mistake is recorded again.',
    apply: repaymentVoidedApplier,
    rule: repaymentVoidedRule,
    permission: P.advances,
    read: P.advances,
    entityType: PAY_REPAYMENT_ENTITY,
  },
  [PAY_OP.salaryPaid]: {
    schemaVersion: 1,
    payload: paidPayload,
    reversal: 'Cancelled by pay.payout_voided.',
    apply: paidApplier,
    rule: paidRule,
    permission: P.pay,
    read: P.read,
    entityType: PAY_PAYOUT_ENTITY,
  },
  [PAY_OP.payoutVoided]: {
    schemaVersion: 1,
    payload: voidedPayload,
    reversal: 'Final: a payout cancelled by mistake is paid again.',
    apply: payoutVoidedApplier,
    rule: payoutVoidedRule,
    permission: P.manage,
    read: P.read,
    entityType: PAY_PAYOUT_ENTITY,
  },
  [PAY_OP.commissionAdjusted]: {
    schemaVersion: 1,
    payload: commissionAdjustedPayload,
    reversal: 'Not reversible: a mistake is put right by another change by hand.',
    apply: commissionAdjustedApplier,
    rule: commissionAdjustedRule,
    permission: P.manage,
    read: P.read,
    entityType: PAY_ADJUSTMENT_ENTITY,
  },
};
