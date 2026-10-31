// How a servisan's approval requests read (approvals' `ApprovalDescription`): the price line a
// discount adds, the fee a cancel charges, what is left to pay later, the right down payment, or a
// payment asked to be cancelled from Kas, in the counter's words.
import { formatMoney } from '@bolusi/i18n';

import type { ApprovalDescription } from '../approvals/copy.js';
import type { ApprovalRow } from '../approvals/queries.js';
import { tn } from './i18n.js';
import { MONEY_APPROVAL_KIND } from '../money/constants.js';
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
      // What the approver's limit counts, when earlier changes on the servisan count with it.
      notes:
        row.counted > row.amount
          ? [tn('repair.approval.downPaymentTakenOff', { amount: formatMoney(row.counted) })]
          : [],
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
