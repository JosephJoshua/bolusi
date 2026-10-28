// The `money` commands, and the op builders other modules use to record money inside their own
// commands (a handover records the charge and the payments next to the handover itself). Whether
// each op may be recorded is its type's rule (rules.ts), run on the device and again on the server.
import { z } from 'zod';

import type { CommandContext, CommandHandlerResult } from '@bolusi/core';
import { zUuid } from '@bolusi/schemas';

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
  type CashMoveKind,
  type RevenueAccount,
} from './constants.js';
import { zDocument, type MoneyDocument } from './documents.js';
import { zAccountRef, zAmount, zReason } from './operations.js';
import { documentMoneyQuery } from './queries.js';
import { MONEY_REFUSALS } from './rules.js';

type OpDraft = ReturnType<CommandContext['op']>;

/** A payment's reference (an EDC approval code, a transfer note): blank means none. */
export const zReference = z
  .string()
  .trim()
  .max(MAX_REFERENCE)
  .nullable()
  .default(null)
  .transform((ref) => (ref === null || ref === '' ? null : ref));

function entryOp(ctx: CommandContext, type: string, payload: object, entityId = ctx.newId()) {
  return ctx.op({
    type,
    entityType: MONEY_ENTRY_ENTITY,
    entityId,
    payload: payload as Record<string, unknown>,
  });
}

// ── op builders for other modules' commands ────────────────────────────────────────────────────

export interface PaymentDraft {
  readonly account: string;
  readonly amount: number;
  readonly reference: string | null;
  readonly tendered: number | null;
  /** The payment this one is recorded in place of; void that one right after. */
  readonly replaces?: string;
}

/** What a customer is charged for a document: exactly what its module says (documents.ts). */
export function chargeOp(
  ctx: CommandContext,
  document: MoneyDocument,
  amount: number,
  account: RevenueAccount,
): OpDraft {
  return entryOp(ctx, MONEY_OP.chargeRecorded, { document, amount, account });
}

export function paymentOp(ctx: CommandContext, document: MoneyDocument, payment: PaymentDraft) {
  return entryOp(ctx, MONEY_OP.paymentReceived, {
    document,
    account: payment.account,
    amount: payment.amount,
    reference: payment.reference,
    tendered: payment.tendered,
    ...(payment.replaces === undefined ? {} : { replaces: payment.replaces }),
  });
}

/** A payment taken back, by an owner: the entry stays, its lines are reversed. */
export function voidOp(ctx: CommandContext, entryId: string, reason: string): OpDraft {
  return entryOp(ctx, MONEY_OP.paymentVoided, { reason }, entryId);
}

export function refundOp(
  ctx: CommandContext,
  document: MoneyDocument,
  refund: { account: string; amount: number; reason: string; reference: string | null },
): OpDraft {
  return entryOp(ctx, MONEY_OP.refundPaid, { document, ...refund });
}

/** One payment as a screen sends it. */
export const zPaymentInput = z
  .object({
    account: zAccountRef,
    amount: zAmount,
    reference: zReference,
    tendered: zAmount.nullable().default(null),
  })
  .strict();
export type PaymentInput = z.input<typeof zPaymentInput>;

// ── accounts ───────────────────────────────────────────────────────────────────────────────────

const accountFields = {
  /** Absent for a new account. */
  accountId: zUuid.optional(),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS),
  name: z.string().trim().min(1).max(MAX_ACCOUNT_NAME),
  active: z.boolean().default(true),
};

export const saveAccountInput = z.object(accountFields).strict();
export type SaveAccountInput = z.input<typeof saveAccountInput>;

export function saveAccountHandler(
  input: z.output<typeof saveAccountInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ accountId: string }> {
  const accountId = input.accountId ?? ctx.newId();
  return {
    ops: [
      ctx.op({
        type: MONEY_OP.accountSaved,
        entityType: MONEY_ACCOUNT_ENTITY,
        entityId: accountId,
        payload: { kind: input.kind, name: input.name, active: input.active },
      }),
    ],
    result: { accountId },
  };
}

export const saveCentralAccountInput = z
  .object({ ...accountFields, storeIds: z.array(zUuid).max(500).default([]) })
  .strict();
export type SaveCentralAccountInput = z.input<typeof saveCentralAccountInput>;

export function saveCentralAccountHandler(
  input: z.output<typeof saveCentralAccountInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ accountId: string }> {
  const accountId = input.accountId ?? ctx.newId();
  return {
    ops: [
      ctx.op({
        type: MONEY_OP.centralAccountSaved,
        entityType: MONEY_ACCOUNT_ENTITY,
        entityId: accountId,
        payload: {
          kind: input.kind,
          name: input.name,
          active: input.active,
          storeIds: [...new Set(input.storeIds)].sort(),
        },
      }),
    ],
    result: { accountId },
  };
}

// ── payments and refunds on a document ─────────────────────────────────────────────────────────

export const receivePaymentsInput = z
  .object({ document: zDocument, payments: z.array(zPaymentInput).min(1).max(10) })
  .strict();
export type ReceivePaymentsInput = z.input<typeof receivePaymentsInput>;

/** A customer pays (part of) what they owe, in one or more methods: a debt paid off later. */
export function receivePaymentsHandler(
  input: z.output<typeof receivePaymentsInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ entryIds: string[] }> {
  const ops = input.payments.map((payment) => paymentOp(ctx, input.document, payment));
  return { ops, result: { entryIds: ops.map((op) => op.entityId) } };
}

export const voidPaymentInput = z.object({ entryId: zUuid, reason: zReason }).strict();
export type VoidPaymentInput = z.input<typeof voidPaymentInput>;

export function voidPaymentHandler(
  input: z.output<typeof voidPaymentInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  return {
    ops: [voidOp(ctx, input.entryId, input.reason)],
    result: null,
  };
}

export const refundInput = z
  .object({
    document: zDocument,
    account: zAccountRef,
    amount: zAmount,
    reason: zReason,
    reference: zReference,
  })
  .strict();
export type RefundInput = z.input<typeof refundInput>;

/**
 * Give money back. What the customer paid beyond their charges goes back as it is; an owner giving
 * back more first takes the difference off the charges, so the customer does not end up owing it.
 * Nobody gives back more than the customer paid.
 */
export async function refundHandler(
  input: z.output<typeof refundInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<null>> {
  const { kind, id } = input.document;
  const money = (await ctx.query(documentMoneyQuery, { kind, id })).rows[0]!;
  const credit = Math.max(0, -money.balance);
  const ops: OpDraft[] = [];
  if (input.amount > credit && ctx.colleagueHasPermission(ctx.userId, MONEY_PERMISSION.refund)) {
    if (input.amount > credit + money.charged - money.reduced) {
      throw MONEY_REFUSALS.refuse('refundAbovePaid', {
        code: 'VALIDATION_FAILED',
        details: { field: 'amount', issue: `at most ${credit + money.charged - money.reduced}` },
      });
    }
    ops.push(
      entryOp(ctx, MONEY_OP.chargeReduced, {
        document: input.document,
        amount: input.amount - credit,
        reason: input.reason,
      }),
    );
  }
  ops.push(
    refundOp(ctx, input.document, {
      account: input.account,
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
    }),
  );
  return { ops, result: null };
}

export const reduceChargeInput = z
  .object({ document: zDocument, amount: zAmount, reason: zReason })
  .strict();
export type ReduceChargeInput = z.input<typeof reduceChargeInput>;

/** An owner forgives (part of) what a customer owes. */
export function reduceChargeHandler(
  input: z.output<typeof reduceChargeInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  return { ops: [entryOp(ctx, MONEY_OP.chargeReduced, input)], result: null };
}

// ── the drawer ─────────────────────────────────────────────────────────────────────────────────

export const moveCashInput = z
  .object({
    kind: z.enum(CASH_MOVE_KINDS),
    amount: zAmount,
    reason: zReason,
    account: zAccountRef.nullable().default(null),
  })
  .strict();
export type MoveCashInput = z.input<typeof moveCashInput>;

export function moveCashHandler(
  input: z.output<typeof moveCashInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ entryId: string }> {
  const kind: CashMoveKind = input.kind;
  const op = entryOp(ctx, MONEY_OP.cashMoved, {
    kind,
    amount: input.amount,
    reason: input.reason,
    account: kind === 'deposit' ? input.account : null,
  });
  return { ops: [op], result: { entryId: op.entityId } };
}

export const countCashInput = z
  .object({
    counted: z.number().int().min(0).max(MAX_AMOUNT),
    note: z.string().trim().max(MAX_REASON).default(''),
  })
  .strict();
export type CountCashInput = z.input<typeof countCashInput>;

export function countCashHandler(
  input: z.output<typeof countCashInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ entryId: string }> {
  const op = entryOp(ctx, MONEY_OP.cashCounted, input);
  return { ops: [op], result: { entryId: op.entityId } };
}

export const adjustCashInput = z
  .object({
    amount: z
      .number()
      .int()
      .min(-MAX_AMOUNT)
      .max(MAX_AMOUNT)
      .refine((n) => n !== 0),
    countId: zUuid,
    reason: zReason,
  })
  .strict();
export type AdjustCashInput = z.input<typeof adjustCashInput>;

export function adjustCashHandler(
  input: z.output<typeof adjustCashInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ entryId: string }> {
  const op = entryOp(ctx, MONEY_OP.cashAdjusted, input);
  return { ops: [op], result: { entryId: op.entityId } };
}
