// The servisan decisions an owner may hand out through an approval request (approvals/kinds.ts):
// a price drop, a cancel (with its fee), a cancelled servisan's lower fee and a down payment fix.
// Approving runs the same command the owner would, as the owner, so its rules (a manager's limit
// included) judge it as if they had done it at the counter. "Bayar nanti" is a permit instead:
// approved, the counter lets the phone go unpaid at handover (`requirePaid`). A request depends on
// the servisan's state and price: once either moves, it closes.
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { approvalKind, type ApprovalKinds, type ApprovalScope } from '../approvals/kinds.js';
import { CASH_ACCOUNT, MONEY_PERMISSION } from '../money/constants.js';
import { takenOffByVoids } from '../money/rules.js';
import type { MoneyDatabase } from '../money/schema.js';
import {
  cancelTicketHandler,
  cancelTicketInput,
  changeCancelFeeHandler,
  changeCancelFeeInput,
  changeQuoteHandler,
  changeQuoteInput,
  correctDownPaymentHandler,
  correctDownPaymentInput,
  replacedPayment,
} from './commands.js';
import { REPAIR_APPROVAL_KIND, REPAIR_PERMISSION, REPAIR_TICKET_ENTITY } from './constants.js';
import { REPAIR_DOCUMENT_KIND } from './money-document.js';
import { cancelDrop } from './queries.js';
import {
  cancelFeeApprovalBasis,
  cancelledFeeStandard,
  cancelStandardFee,
  handoverDebt,
  ticketApprovalBasis,
  ticketDiscounts,
} from './rules.js';
import type { RepairDatabase } from './schema.js';

function ticketRef(db: Kysely<never>, scope: ApprovalScope, ticketId: string) {
  return {
    db: db as unknown as Kysely<RepairDatabase>,
    ref: { tenantId: scope.tenantId, storeId: scope.storeId, entityId: ticketId },
  };
}

function ticketTarget(input: { readonly ticketId: string }) {
  return { entityType: REPAIR_TICKET_ENTITY, entityId: input.ticketId };
}

async function basisOf(db: Kysely<never>, scope: ApprovalScope, ticketId: string) {
  const at = ticketRef(db, scope, ticketId);
  return ticketApprovalBasis(at.db, at.ref);
}

/** The servisan's payments that still count, oldest first, as its money reads them. */
function livePayments(db: Kysely<never>, scope: ApprovalScope, ticketId: string) {
  return (db as unknown as Kysely<MoneyDatabase>)
    .selectFrom('moneyEntries')
    .select(['id', 'account', 'amount'])
    .where('storeId', '=', scope.storeId)
    .where('kind', '=', 'payment_received')
    .where('documentKind', '=', REPAIR_DOCUMENT_KIND)
    .where('documentId', '=', ticketId)
    .where('voidedBy', 'is', null)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
}

/**
 * What fixing the down payment to `input.amount` takes off the servisan's money, as the voids it
 * makes count it (money `takenOffByVoids`): the DP's decrease through the same method, or all
 * of it through another. Null when there is nothing to fix.
 */
async function downPaymentTakenOff(
  db: Kysely<never>,
  scope: ApprovalScope,
  input: z.output<typeof correctDownPaymentInput>,
): Promise<number | null> {
  const rows = await livePayments(db, scope, input.ticketId);
  const live = rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  if (live.length === 0) return null;
  const account = input.account ?? live[0]?.account ?? CASH_ACCOUNT;
  const replaced = input.amount > 0 ? replacedPayment(live, account) : undefined;
  return takenOffByVoids(
    db as unknown as Kysely<MoneyDatabase>,
    scope.storeId,
    { kind: REPAIR_DOCUMENT_KIND, id: input.ticketId },
    {
      voiding: live,
      ...(replaced === undefined
        ? {}
        : { paying: { replaces: replaced.id, amount: input.amount } }),
      // Whenever it is made, the fix comes after everything recorded now.
      at: Number.MAX_SAFE_INTEGER,
    },
  );
}

const payLaterInput = z.object({ ticketId: z.string().min(1) }).strict();

export const repairApprovalKinds: ApprovalKinds = {
  /** A price line that lowers the price (a discount), applied as the approver's. */
  [REPAIR_APPROVAL_KIND.discount]: approvalKind({
    id: REPAIR_APPROVAL_KIND.discount,
    input: changeQuoteInput,
    handler: changeQuoteHandler,
    commandPermission: REPAIR_PERMISSION.quoteChange,
    permission: REPAIR_PERMISSION.discount,
    askPermission: REPAIR_PERMISSION.quoteChange,
    fits: (input) => input.amount < 0,
    target: ticketTarget,
    amount: async (db, scope, input) =>
      (await basisOf(db, scope, input.ticketId)) === null ? null : -input.amount,
    // A discount limit is per servisan: the discounts already on it count with this one.
    counted: async (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      return (await ticketDiscounts(at.db, at.ref)) - input.amount;
    },
    basis: (db, scope, input) => basisOf(db, scope, input.ticketId),
  }),
  /** A cancel, at the store's fee or a lower one; what it is worth is how far below the fee. */
  [REPAIR_APPROVAL_KIND.cancel]: approvalKind({
    id: REPAIR_APPROVAL_KIND.cancel,
    input: cancelTicketInput,
    handler: cancelTicketHandler,
    commandPermission: REPAIR_PERMISSION.cancel,
    permission: REPAIR_PERMISSION.cancel,
    askPermission: REPAIR_PERMISSION.intake,
    fits: () => true,
    target: ticketTarget,
    amount: async (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      const standard = await cancelStandardFee(at.db, at.ref);
      if (standard === null) return null;
      return Math.max(0, standard - (input.fee ?? standard));
    },
    // A smaller fee counts with the discounts already on the servisan, as the rule counts it.
    counted: async (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      const standard = (await cancelStandardFee(at.db, at.ref)) ?? 0;
      return cancelDrop(standard, input.fee ?? standard, await ticketDiscounts(at.db, at.ref));
    },
    basis: (db, scope, input) => basisOf(db, scope, input.ticketId),
  }),
  /**
   * A cancelled servisan's fee lowered afterwards, before anything is charged (Ubah biaya), by a
   * manager beyond their cancel limit: counted from the store's fee with the discounts, as the
   * fee change's rule counts it. Once charged, a lower bill is a cut off the charge, asked as
   * money's own (money.reduceCharge), so this one closes then.
   */
  [REPAIR_APPROVAL_KIND.cancelFee]: approvalKind({
    id: REPAIR_APPROVAL_KIND.cancelFee,
    input: changeCancelFeeInput,
    handler: changeCancelFeeHandler,
    commandPermission: REPAIR_PERMISSION.cancel,
    permission: REPAIR_PERMISSION.cancel,
    // Only someone who changes the fee asks: a manager beyond their limit.
    askPermission: REPAIR_PERMISSION.cancel,
    fits: () => true,
    target: ticketTarget,
    amount: async (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      const standard = await cancelledFeeStandard(at.db, at.ref);
      return standard === null ? null : Math.max(0, standard - input.fee);
    },
    counted: async (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      const standard = (await cancelledFeeStandard(at.db, at.ref)) ?? 0;
      return cancelDrop(standard, input.fee, await ticketDiscounts(at.db, at.ref));
    },
    basis: (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      return cancelFeeApprovalBasis(at.db, at.ref);
    },
  }),
  /**
   * Letting the phone go unpaid at handover, up to what is left to pay now: a permit the counter
   * uses with the customer there, so nothing happens when it is approved.
   */
  [REPAIR_APPROVAL_KIND.payLater]: approvalKind({
    id: REPAIR_APPROVAL_KIND.payLater,
    input: payLaterInput,
    commandPermission: MONEY_PERMISSION.extendCredit,
    permission: MONEY_PERMISSION.extendCredit,
    askPermission: REPAIR_PERMISSION.handover,
    fits: () => true,
    target: ticketTarget,
    amount: (db, scope, input) => {
      const at = ticketRef(db, scope, input.ticketId);
      return handoverDebt(at.db, at.ref);
    },
    basis: (db, scope, input) => basisOf(db, scope, input.ticketId),
  }),
  /**
   * A down payment fixed to another amount or method. It voids the payments taken and records the
   * right one, so what it is worth is what those voids take off, held to the refund limit.
   */
  [REPAIR_APPROVAL_KIND.downPayment]: approvalKind({
    id: REPAIR_APPROVAL_KIND.downPayment,
    input: correctDownPaymentInput,
    handler: correctDownPaymentHandler,
    commandPermission: REPAIR_PERMISSION.correctDownPayment,
    permission: REPAIR_PERMISSION.correctDownPayment,
    limitPermission: MONEY_PERMISSION.voidPayment,
    askPermission: REPAIR_PERMISSION.intake,
    fits: () => true,
    target: ticketTarget,
    amount: async (db, scope, input) =>
      (await basisOf(db, scope, input.ticketId)) === null
        ? null
        : downPaymentTakenOff(db, scope, input),
    // The payments it voids are part of what it was asked against.
    basis: async (db, scope, input) => {
      const basis = await basisOf(db, scope, input.ticketId);
      if (basis === null) return null;
      const live = await livePayments(db, scope, input.ticketId);
      return [basis, ...live.map((row) => row.id)].join('|');
    },
  }),
};
