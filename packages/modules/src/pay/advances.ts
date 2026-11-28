// A person's kasbon at a store: one balance, however many were handed out. Repayments pay the
// oldest kasbon first, so what comes off the next payout is the agreed installment of each kasbon
// still open, never more than the balance. Read by the queries and by the payout rule alike.
import type { ReadonlyProjectionDb } from '@bolusi/core';

import type { PayScope } from './commission.js';
import type { PayDatabase } from './schema.js';

export interface AdvanceBalance {
  /** Handed out less repaid, in rupiah; never below zero in practice (the rules keep it so). */
  readonly balance: number;
  /** What the next payout takes by default: the installments of the kasbon still open. */
  readonly installment: number;
}

export async function advanceBalance(
  db: ReadonlyProjectionDb<PayDatabase>,
  scope: PayScope,
  userId: string,
): Promise<AdvanceBalance> {
  const advances = await db
    .selectFrom('payAdvances')
    .select(['id', 'amount', 'installment', 'createdAt'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where('userId', '=', userId)
    .where('voidedAt', 'is', null)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  const repaid = await db
    .selectFrom('payRepayments')
    .select(['amount'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId)
    .where('userId', '=', userId)
    .where('voidedAt', 'is', null)
    .execute();
  let left = repaid.reduce((sum, row) => sum + Number(row.amount), 0);
  let balance = 0;
  let installment = 0;
  for (const advance of advances) {
    const amount = Number(advance.amount);
    const covered = Math.min(amount, left);
    left -= covered;
    const open = amount - covered;
    balance += open;
    if (open > 0) installment += Math.min(open, Number(advance.installment));
  }
  // Repaid beyond every kasbon (a cancelled kasbon after a repayment) is not a balance either way.
  return { balance, installment: Math.min(installment, balance) };
}
