// The supplier payment commands: pay a supplier for a bill (or ahead of one), or cancel a payment
// recorded by mistake. Paid from the drawer, the same command takes the cash off the drawer's book
// with money's op under the payment's own id (money payouts.ts). Whether each may be recorded is
// its op's rule, run here before saving and on the server on push.
import { z } from 'zod';

import { DomainError, type CommandContext, type CommandHandlerResult } from '@bolusi/core';

import { seesExpected } from '../../money/kas.js';
import { CASH_ACCOUNT, MONEY_ENTRY_ENTITY, MONEY_OP } from '../../money/constants.js';
import { drawerForMoveQuery } from '../../money/queries.js';
import { MONEY_REFUSALS } from '../../money/rules.js';
import { zOptionalText } from '../../shared/optional-text.js';
import {
  MAX_PAYMENT,
  MAX_PAYMENT_REFERENCE,
  MAX_PURCHASING_NOTE,
  PURCHASING_OP,
  PURCHASING_PAYMENT_ENTITY,
} from '../constants.js';
import { zPaymentSource } from './operations.js';
import { payoutAccountOf } from './payout.js';
import { supplierPaymentQuery } from './queries.js';

export const paySupplierInput = z
  .object({
    supplierId: z.string().min(1),
    /** The bill it pays, or null to pay ahead of any bill. */
    billId: z.string().min(1).nullable().default(null),
    amount: z.number().int().min(1).max(MAX_PAYMENT),
    source: zPaymentSource,
    reference: zOptionalText(MAX_PAYMENT_REFERENCE),
    note: zOptionalText(MAX_PURCHASING_NOTE),
  })
  .strict();
export type PaySupplierInput = z.input<typeof paySupplierInput>;

/**
 * Pay a supplier. From the drawer, nobody who sees the drawer pays out more than its book says is
 * in it (as a cash move, money commands.ts); the server records cash as it really moved.
 */
export async function paySupplierHandler(
  input: z.output<typeof paySupplierInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ paymentId: string }>> {
  if (
    input.source === CASH_ACCOUNT &&
    seesExpected((permission) => ctx.colleagueHasPermission(ctx.userId, permission))
  ) {
    const drawer = (await ctx.query(drawerForMoveQuery, { counts: 0 })).rows[0]!.expected;
    if (input.amount > drawer) {
      throw MONEY_REFUSALS.refuseOnDevice('moveAboveDrawer', {
        code: 'VALIDATION_FAILED',
        details: { field: 'amount', issue: `at most ${Math.max(0, drawer)}` },
      });
    }
  }
  const paymentId = ctx.newId();
  const ops = [
    ctx.op({
      type: PURCHASING_OP.supplierPaid,
      entityType: PURCHASING_PAYMENT_ENTITY,
      entityId: paymentId,
      payload: {
        supplierId: input.supplierId,
        billId: input.billId,
        amount: input.amount,
        source: input.source,
        reference: input.reference,
        note: input.note,
      },
    }),
    // The ledger's side, whichever account it is paid from, so Kas and the books see it.
    ctx.op({
      type: MONEY_OP.supplierPaid,
      entityType: MONEY_ENTRY_ENTITY,
      entityId: paymentId,
      payload: { amount: input.amount, account: payoutAccountOf(input.source) },
    }),
  ];
  return { ops, result: { paymentId } };
}

export const voidSupplierPaymentInput = z
  .object({
    paymentId: z.string().min(1),
    /** Why it is cancelled: the payment stays in the history with it. */
    reason: z.string().trim().min(1).max(MAX_PURCHASING_NOTE),
  })
  .strict();
export type VoidSupplierPaymentInput = z.input<typeof voidSupplierPaymentInput>;

export async function voidSupplierPaymentHandler(
  input: z.output<typeof voidSupplierPaymentInput>,
  ctx: CommandContext,
): Promise<CommandHandlerResult<{ paymentId: string }>> {
  const payment = (await ctx.query(supplierPaymentQuery, { paymentId: input.paymentId })).rows[0];
  if (payment === undefined) {
    throw new DomainError('ENTITY_NOT_FOUND', {
      entityType: PURCHASING_PAYMENT_ENTITY,
      entityId: input.paymentId,
    });
  }
  const payload = { reason: input.reason };
  const ops = [
    ctx.op({
      type: PURCHASING_OP.supplierPaymentVoided,
      entityType: PURCHASING_PAYMENT_ENTITY,
      entityId: payment.id,
      payload,
    }),
    ctx.op({
      type: MONEY_OP.supplierPaymentVoided,
      entityType: MONEY_ENTRY_ENTITY,
      entityId: payment.id,
      payload,
    }),
  ];
  return { ops, result: { paymentId: payment.id } };
}
