// Module-owned translations for `money`, merged into the app's i18n instance like repair's.
// The key list is pinned to both shipped catalogs by apps/mobile/test/module-catalog-keys.test.ts.
import {
  moduleTranslator,
  registerModuleCatalog,
  type ModuleCatalogs,
} from '../screen-kit/i18n.js';

export const MONEY_KEYS = [
  'money.opType.accountSaved',
  'money.opType.cashAdjusted',
  'money.opType.cashCounted',
  'money.opType.cashMoved',
  'money.opType.centralAccountSaved',
  'money.opType.chargeRecorded',
  'money.opType.chargeReduced',
  'money.opType.paymentReceived',
  'money.opType.paymentVoided',
  'money.opType.refundPaid',
  'money.refusal.aboveCharged',
  'money.refusal.accountKindChanged',
  'money.refusal.accountNotUsable',
  'money.refusal.alreadyRecorded',
  'money.refusal.alreadyVoided',
  'money.refusal.chargeMismatch',
  'money.refusal.countNotFound',
  'money.refusal.countSettled',
  'money.refusal.documentNotFound',
  'money.refusal.notChargeable',
  'money.refusal.notThisStore',
  'money.refusal.paymentNotFound',
  'money.refusal.referenceRequired',
  'money.refusal.refundAboveCredit',
  'money.refusal.notCharged',
  'money.refusal.refundAbovePaid',
  'money.refusal.tenderedTooLow',
] as const;

export type MoneyKey = (typeof MONEY_KEYS)[number];

/** Translate a `money.*` key (see `moduleTranslator`). */
export const tm = moduleTranslator<MoneyKey>();

/** Merge the money catalog under the `money` namespace. Idempotent (deep + overwrite). */
export function registerMoneyCatalog(catalogs: ModuleCatalogs): void {
  registerModuleCatalog('money', catalogs);
}
