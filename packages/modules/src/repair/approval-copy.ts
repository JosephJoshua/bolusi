// How a servisan's approval requests read (approvals' `ApprovalDescription`): the price line a
// discount adds, the fee a cancel charges, what is left to pay later, the right down payment, a
// payment asked to be cancelled from Kas, or money given back or taken off the bill beyond a
// manager's limit, in the counter's words. A cancelled servisan's fee reads as the fee typed.
import { formatMoney } from '@bolusi/i18n';

import type { ApprovalDescription } from '../approvals/copy.js';
import type { ApprovalRow } from '../approvals/queries.js';
import { tn } from './i18n.js';
import { CASH_ACCOUNT, MONEY_APPROVAL_KIND } from '../money/constants.js';
import { tm } from '../money/i18n.js';
import { REPAIR_APPROVAL_KIND } from './constants.js';

export function describeRepairApproval(row: ApprovalRow): ApprovalDescription {
  const input = row.input;
  if (row.kind === REPAIR_APPROVAL_KIND.discount) {
    return {
      title: String(input['description'] ?? ''),
      amount: formatMoney(Number(input['amount'] ?? 0)),
      notes: [tn('repair.approval.discountAfter')],
    };
  }
  if (row.kind === REPAIR_APPROVAL_KIND.payLater) {
    return {
      title: tn('repair.approval.payLaterDebt'),
      amount: formatMoney(row.amount),
      notes: [tn('repair.approval.payLaterAfter')],
    };
  }
  if (row.kind === MONEY_APPROVAL_KIND.voidPayment) {
    return {
      title: tn('repair.approval.voidPayment'),
      amount: formatMoney(row.amount),
      notes: takenOffWith(row),
    };
  }
  if (row.kind === MONEY_APPROVAL_KIND.refund) {
    return {
      title: tn('repair.approval.refund'),
      amount: formatMoney(row.amount),
      notes: [
        tn('repair.approval.refundThrough', {
          // Cash in the reader's own words; any other method by the name the store gave it.
          method:
            input['account'] === CASH_ACCOUNT
              ? tm('money.method.cash')
              : String(input['methodLabel'] ?? ''),
        }),
        ...takenOffWith(row),
      ],
    };
  }
  if (row.kind === MONEY_APPROVAL_KIND.reduceCharge) {
    return {
      title: tn('repair.approval.reduceCharge'),
      amount: formatMoney(row.amount),
      notes: takenOffWith(row),
    };
  }
  if (row.kind === REPAIR_APPROVAL_KIND.downPayment) {
    return {
      title: tn('repair.approval.downPaymentNew'),
      amount: formatMoney(Number(input['amount'] ?? 0)),
      notes: [tn('repair.approval.downPaymentTakenOff', { amount: formatMoney(row.amount) })],
    };
  }
  const fee = input['fee'];
  if (row.kind === REPAIR_APPROVAL_KIND.cancelFeeCharged) {
    return {
      title: tn('repair.cancel.fee'),
      amount: typeof fee === 'number' ? formatMoney(fee) : null,
      notes: [
        tn('repair.approval.cancelBillDown', { amount: formatMoney(row.amount) }),
        ...takenOffWith(row),
      ],
    };
  }
  return {
    title: tn('repair.cancel.fee'),
    amount: typeof fee === 'number' ? formatMoney(fee) : null,
    notes: [
      typeof fee === 'number' && row.amount > 0
        ? tn('repair.approval.cancelBelow', { amount: formatMoney(row.amount) })
        : tn('repair.approval.cancelStoreFee'),
    ],
  };
}

/** What the approver's limit counts, when earlier changes on the servisan count with it. */
function takenOffWith(row: ApprovalRow): string[] {
  return row.counted > row.amount
    ? [tn('repair.approval.downPaymentTakenOff', { amount: formatMoney(row.counted) })]
    : [];
}
