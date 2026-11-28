// The `pay` commands. Whether each may be recorded is its op's rule, run here before saving and on
// the server on push; the commands only work out what the screens leave to the app (the commission
// a payout pays, the installment it can take) and record the ops that go together.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import { zOptionalText } from '../shared/optional-text.js';
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
  PAY_REPAYMENT_ENTITY,
  PAY_STORE_ENTITY,
  SALARY_REPAYMENT,
  WRITTEN_OFF,
} from './constants.js';
import { zPayAccount } from './operations.js';
import { kasbonQuery, payPersonQuery } from './queries.js';

const zUserId = z.string().min(1);
const zAmount = z.number().int().min(1).max(MAX_PAY_AMOUNT);
const zReason = z.string().trim().min(1).max(MAX_PAY_NOTE);
const zPercent = z.number().int().min(1).max(MAX_COMMISSION_PERCENT);

// ── terms ────────────────────────────────────────────────────────────────────────────────────

export const setTermsInput = z
  .object({
    userId: zUserId,
    salary: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    commissionPercent: zPercent.nullable().default(null),
  })
  .strict();
export type SetTermsInput = z.input<typeof setTermsInput>;

export function setTermsHandler(
  input: z.output<typeof setTermsInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  const op = ctx.op({
    type: PAY_OP.termsSet,
    entityType: PAY_EMPLOYEE_ENTITY,
    entityId: input.userId,
    payload: { salary: input.salary, commissionPercent: input.commissionPercent },
  });
  return { ops: [op], result: null };
}

export const setStoreCommissionInput = z
  .object({ commissionPercent: zPercent.nullable() })
  .strict();
export type SetStoreCommissionInput = z.input<typeof setStoreCommissionInput>;

export function setStoreCommissionHandler(
  input: z.output<typeof setStoreCommissionInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  if (ctx.storeId === null) {
    throw new DomainError('VALIDATION_FAILED', { field: 'storeId', issue: 'no store' });
  }
  const op = ctx.op({
    type: PAY_OP.storeCommissionSet,
    entityType: PAY_STORE_ENTITY,
    entityId: ctx.storeId,
    payload: { commissionPercent: input.commissionPercent },
  });
  return { ops: [op], result: null };
}

// ── kasbon ───────────────────────────────────────────────────────────────────────────────────

export const giveAdvanceInput = z
  .object({
    userId: zUserId,
    amount: zAmount,
    account: zPayAccount,
    reason: zReason,
    installment: zAmount,
  })
  .strict();
export type GiveAdvanceInput = z.input<typeof giveAdvanceInput>;

export function giveAdvanceHandler(
  input: z.output<typeof giveAdvanceInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ advanceId: string }> {
  const advanceId = ctx.newId();
  const op = ctx.op({
    type: PAY_OP.advanceGranted,
    entityType: PAY_ADVANCE_ENTITY,
    entityId: advanceId,
    payload: {
      userId: input.userId,
      amount: input.amount,
      account: input.account,
      reason: input.reason,
      installment: input.installment,
    },
  });
  return { ops: [op], result: { advanceId } };
}

export const repayAdvanceInput = z
  .object({
    userId: zUserId,
    amount: zAmount,
    account: zPayAccount,
    note: zOptionalText(MAX_PAY_NOTE),
  })
  .strict();
export type RepayAdvanceInput = z.input<typeof repayAdvanceInput>;

/** Kasbon paid back into Kas: into the drawer or a bank account. */
export function repayAdvanceHandler(
  input: z.output<typeof repayAdvanceInput>,
  ctx: CommandContext,
): CommandHandlerResult<{ repaymentId: string }> {
  const repaymentId = ctx.newId();
  const op = ctx.op({
    type: PAY_OP.advanceSettled,
    entityType: PAY_REPAYMENT_ENTITY,
    entityId: repaymentId,
    payload: {
      userId: input.userId,
      amount: input.amount,
      via: input.account,
      payoutId: null,
      note: input.note,
    },
  });
  return { ops: [op], result: { repaymentId } };
}

export const writeOffAdvanceInput = z.object({ userId: zUserId, reason: zReason }).strict();
export type WriteOffAdvanceInput = z.input<typeof writeOffAdvanceInput>;

/** An owner writes off what is left of someone's kasbon (they left and cannot pay it back). */
export async function writeOffAdvanceHandler(
  input: z.output<typeof writeOffAdvanceInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ repaymentId: string }>> {
  const { balance } = (await ctx.query(kasbonQuery, { userId: input.userId })).rows[0]!;
  if (balance <= 0) {
    throw new DomainError('VALIDATION_FAILED', { field: 'userId', issue: 'no kasbon open' });
  }
  const repaymentId = ctx.newId();
  const op = ctx.op({
    type: PAY_OP.advanceSettled,
    entityType: PAY_REPAYMENT_ENTITY,
    entityId: repaymentId,
    payload: {
      userId: input.userId,
      amount: balance,
      via: WRITTEN_OFF,
      payoutId: null,
      note: input.reason,
    },
  });
  return { ops: [op], result: { repaymentId } };
}

export const voidInput = z.object({ id: z.string().min(1), reason: zReason }).strict();
export type VoidInput = z.input<typeof voidInput>;

export function voidAdvanceHandler(
  input: z.output<typeof voidInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  const op = ctx.op({
    type: PAY_OP.advanceVoided,
    entityType: PAY_ADVANCE_ENTITY,
    entityId: input.id,
    payload: { reason: input.reason },
  });
  return { ops: [op], result: null };
}

export function voidRepaymentHandler(
  input: z.output<typeof voidInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  const op = ctx.op({
    type: PAY_OP.repaymentVoided,
    entityType: PAY_REPAYMENT_ENTITY,
    entityId: input.id,
    payload: { reason: input.reason },
  });
  return { ops: [op], result: null };
}

// ── payouts ──────────────────────────────────────────────────────────────────────────────────

export const payMonthInput = z
  .object({
    userId: zUserId,
    month: z.string().regex(MONTH_PATTERN),
    salary: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    /** The kasbon installment to take this month; capped at the balance and at what is paid. */
    deduction: z.number().int().min(0).max(MAX_PAY_AMOUNT),
    account: zPayAccount,
    note: zOptionalText(MAX_PAY_NOTE),
    /** When the screen showed the figures: commission is read up to then. */
    at: z.number().int(),
  })
  .strict();
export type PayMonthInput = z.input<typeof payMonthInput>;

export interface PayoutFigures {
  readonly salary: number;
  readonly commission: number;
  readonly deduction: number;
  readonly paid: number;
}

/**
 * What a payout pays: all the commission owed (a take-back at most down to no pay at all; the rest
 * waits for next month), and the installment as far as the balance and the pay go.
 */
export function payoutFigures(input: {
  readonly salary: number;
  readonly owed: number;
  readonly deduction: number;
  readonly kasbon: number;
}): PayoutFigures {
  const commission = Math.max(input.owed, -input.salary);
  const gross = input.salary + commission;
  const deduction = Math.max(0, Math.min(input.deduction, input.kasbon, gross));
  return { salary: input.salary, commission, deduction, paid: gross - deduction };
}

export async function payMonthHandler(
  input: z.output<typeof payMonthInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ payoutId: string } & PayoutFigures>> {
  const statement = (await ctx.query(payPersonQuery, { userId: input.userId, at: input.at }))
    .rows[0]!;
  const kasbon = (await ctx.query(kasbonQuery, { userId: input.userId })).rows[0]!.balance;
  const figures = payoutFigures({
    salary: input.salary,
    owed: statement.commission.owed,
    deduction: input.deduction,
    kasbon,
  });
  const payoutId = ctx.newId();
  const repaymentId = figures.deduction > 0 ? ctx.newId() : null;
  const ops = [
    ctx.op({
      type: PAY_OP.salaryPaid,
      entityType: PAY_PAYOUT_ENTITY,
      entityId: payoutId,
      payload: {
        userId: input.userId,
        month: input.month,
        ...figures,
        repaymentId,
        account: input.account,
        note: input.note,
      },
    }),
  ];
  if (repaymentId !== null) {
    ops.push(
      ctx.op({
        type: PAY_OP.advanceSettled,
        entityType: PAY_REPAYMENT_ENTITY,
        entityId: repaymentId,
        payload: {
          userId: input.userId,
          amount: figures.deduction,
          via: SALARY_REPAYMENT,
          payoutId,
          note: null,
        },
      }),
    );
  }
  return { ops, result: { payoutId, ...figures } };
}

export const voidPayoutInput = z
  .object({
    payoutId: z.string().min(1),
    repaymentId: z.string().min(1).nullable(),
    reason: zReason,
  })
  .strict();
export type VoidPayoutInput = z.input<typeof voidPayoutInput>;

/** A payout cancelled, and its installment with it, so the kasbon is owed again. */
export function voidPayoutHandler(
  input: z.output<typeof voidPayoutInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  const payload = { reason: input.reason };
  const ops = [
    ctx.op({
      type: PAY_OP.payoutVoided,
      entityType: PAY_PAYOUT_ENTITY,
      entityId: input.payoutId,
      payload,
    }),
  ];
  if (input.repaymentId !== null) {
    ops.push(
      ctx.op({
        type: PAY_OP.repaymentVoided,
        entityType: PAY_REPAYMENT_ENTITY,
        entityId: input.repaymentId,
        payload,
      }),
    );
  }
  return { ops, result: null };
}

// ── commission by hand ───────────────────────────────────────────────────────────────────────

export const adjustCommissionInput = z
  .object({
    userId: zUserId,
    amount: z.number().int().min(-MAX_PAY_AMOUNT).max(MAX_PAY_AMOUNT),
    reason: zReason,
  })
  .strict();
export type AdjustCommissionInput = z.input<typeof adjustCommissionInput>;

export function adjustCommissionHandler(
  input: z.output<typeof adjustCommissionInput>,
  ctx: CommandContext,
): CommandHandlerResult<null> {
  const op = ctx.op({
    type: PAY_OP.commissionAdjusted,
    entityType: PAY_ADJUSTMENT_ENTITY,
    entityId: ctx.newId(),
    payload: { userId: input.userId, amount: input.amount, reason: input.reason },
  });
  return { ops: [op], result: null };
}
