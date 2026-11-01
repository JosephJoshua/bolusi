// Module-owned translations for `approvals`, merged into the app's i18n instance like money's.
// The key list is pinned to both shipped catalogs by apps/mobile/test/module-catalog-keys.test.ts.
import {
  moduleTranslator,
  registerModuleCatalog,
  type ModuleCatalogs,
} from '../screen-kit/i18n.js';

export const APPROVALS_KEYS = [
  'approvals.opType.requestMade',
  'approvals.opType.requestApproved',
  'approvals.opType.requestRejected',
  'approvals.opType.requestWithdrawn',
  'approvals.refusal.unknownKind',
  'approvals.refusal.notNeeded',
  'approvals.refusal.cannotAsk',
  'approvals.refusal.targetNotFound',
  'approvals.refusal.changed',
  'approvals.refusal.alreadyAsked',
  'approvals.refusal.requestNotFound',
  'approvals.refusal.alreadyAnswered',
  'approvals.refusal.ownRequest',
  'approvals.refusal.cannotDecide',
  'approvals.refusal.notYours',
  'approvals.refusal.overLimit',
  'approvals.kind.repairDiscount',
  'approvals.kind.repairCancel',
  'approvals.kind.repairPayLater',
  'approvals.kind.repairDownPayment',
  'approvals.kind.repairCancelFee',
  'approvals.kind.repairCancelFeeCharged',
  'approvals.kind.moneyVoidPayment',
  'approvals.kind.moneyRefund',
  'approvals.kind.moneyReduceCharge',
  'approvals.status.waiting',
  'approvals.status.approved',
  'approvals.status.rejected',
  'approvals.status.withdrawn',
  'approvals.status.closed',
  'approvals.section.title',
  'approvals.row.askedBy',
  'approvals.row.answeredBy',
  'approvals.row.answeredNote',
  'approvals.row.withdrawn',
  'approvals.step.title',
  'approvals.step.askedBy',
  'approvals.step.question',
  'approvals.step.note',
  'approvals.step.beyondLimit',
  'approvals.action.ask',
  'approvals.action.approve',
  'approvals.action.reject',
  'approvals.action.withdraw',
  'approvals.action.decide',
  'approvals.action.open',
  'approvals.withdraw.title',
  'approvals.withdraw.message',
  'approvals.done.asked',
  'approvals.done.approved',
  'approvals.done.rejected',
  'approvals.done.withdrawn',
] as const;

export type ApprovalsKey = (typeof APPROVALS_KEYS)[number];

/** Translate an `approvals.*` key (see `moduleTranslator`). */
export const ta = moduleTranslator<ApprovalsKey>();

/** Merge the approvals catalog under the `approvals` namespace. Idempotent (deep + overwrite). */
export function registerApprovalsCatalog(catalogs: ModuleCatalogs): void {
  registerModuleCatalog('approvals', catalogs);
}

/** A kind's copy key: `repair.discount` reads as `approvals.kind.repairDiscount`. */
export function approvalKindKey(kind: string): ApprovalsKey {
  const [module = '', decision = ''] = kind.split('.');
  return `approvals.kind.${module}${decision.charAt(0).toUpperCase()}${decision.slice(1)}` as ApprovalsKey;
}
