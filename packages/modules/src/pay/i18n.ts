// Module-owned translations for `pay`, merged into the app's i18n instance like purchasing's.
// The key list is pinned to both shipped catalogs by apps/mobile/test/module-catalog-keys.test.ts.
import {
  moduleTranslator,
  registerModuleCatalog,
  type ModuleCatalogs,
} from '../screen-kit/i18n.js';

export const PAY_KEYS = [
  'pay.opType.termsSet',
  'pay.opType.storeCommissionSet',
  'pay.opType.advanceGranted',
  'pay.opType.advanceSettled',
  'pay.opType.repaymentVoided',
  'pay.opType.advanceVoided',
  'pay.opType.salaryPaid',
  'pay.opType.payoutVoided',
  'pay.opType.commissionAdjusted',
  'pay.refusal.notStaff',
  'pay.refusal.self',
  'pay.refusal.alreadyRecorded',
  'pay.refusal.accountNotUsable',
  'pay.refusal.installmentAboveAmount',
  'pay.refusal.aboveBalance',
  'pay.refusal.advanceNotFound',
  'pay.refusal.advanceSettled',
  'pay.refusal.repaymentNotFound',
  'pay.refusal.repaymentNotAsPayout',
  'pay.refusal.payoutNotFound',
  'pay.refusal.alreadyVoided',
  'pay.refusal.drawerSettled',
  'pay.refusal.monthPaid',
  'pay.refusal.monthOutOfRange',
  'pay.refusal.salaryAboveTerms',
  'pay.refusal.commissionAboveOwed',
  'pay.refusal.paidNotTotal',
  'pay.refusal.zeroAdjustment',
  'pay.refusal.writeOffOwners',
  'pay.refusal.otherStore',
] as const;

export type PayKey = (typeof PAY_KEYS)[number];

/** Translate a `pay.*` key (see `moduleTranslator`). */
export const tpay = moduleTranslator<PayKey>();

/** Merge the pay catalog under the `pay` namespace. Idempotent (deep + overwrite). */
export function registerPayCatalog(catalogs: ModuleCatalogs): void {
  registerModuleCatalog('pay', catalogs);
}
