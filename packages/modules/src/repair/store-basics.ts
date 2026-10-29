/**
 * What a store still lacks before its slips and payments look like its own: the slip header's
 * address and phone, a logo, its own terms, and a payment method besides cash. The owner's
 * new-device setup lists them, each leading to the setting that fills it. Only what the person may
 * change is listed, and nothing while it loads.
 */
import { MONEY_PERMISSION } from '../money/constants.js';
import type { PaymentAccountRow } from '../money/queries.js';

import { REPAIR_PERMISSION } from './constants.js';
import type { RepairKey } from './i18n.js';
import type { PrintSettings } from './queries.js';
import { usePaymentAccounts, usePrintSettings, useRepairRuntime } from './runtime.js';

export type StoreBasic = 'slipHeader' | 'logo' | 'terms' | 'paymentMethods';

/** Where each one is filled in: the slip's look, or the payment methods. */
export const STORE_BASIC_SETTING: Readonly<Record<StoreBasic, 'printSettings' | 'paymentMethods'>> =
  {
    slipHeader: 'printSettings',
    logo: 'printSettings',
    terms: 'printSettings',
    paymentMethods: 'paymentMethods',
  };

export const STORE_BASIC_KEY: Readonly<
  Record<StoreBasic, { readonly title: RepairKey; readonly summary: RepairKey }>
> = {
  slipHeader: { title: 'repair.basics.slipHeader', summary: 'repair.basics.slipHeaderSummary' },
  logo: { title: 'repair.basics.logo', summary: 'repair.basics.logoSummary' },
  terms: { title: 'repair.basics.terms', summary: 'repair.basics.termsSummary' },
  paymentMethods: {
    title: 'repair.basics.paymentMethods',
    summary: 'repair.basics.paymentMethodsSummary',
  },
};

/** What is missing from what was read; a part not read (null) is not listed. */
export function missingStoreBasics(
  slip: PrintSettings | null,
  methods: readonly PaymentAccountRow[] | null,
): StoreBasic[] {
  const missing: StoreBasic[] = [];
  if (slip !== null) {
    if (slip.address.trim() === '' && slip.phone.trim() === '') missing.push('slipHeader');
    if (slip.logo === null) missing.push('logo');
    if (slip.intakeTerms === null && slip.handoverTerms === null) missing.push('terms');
  }
  if (methods !== null && !methods.some((method) => method.active)) missing.push('paymentMethods');
  return missing;
}

/** The store basics this person may still fill in, live as they are saved; null while loading. */
export function useMissingStoreBasics(): readonly StoreBasic[] | null {
  const runtime = useRepairRuntime();
  const slip = usePrintSettings();
  const methods = usePaymentAccounts();
  const canSlip = runtime.hasPermission(REPAIR_PERMISSION.setPrintSettings);
  const canMethods =
    runtime.money.hasPermission(MONEY_PERMISSION.receive) &&
    (runtime.money.hasPermission(MONEY_PERMISSION.manageAccounts) ||
      runtime.money.hasPermission(MONEY_PERMISSION.manageCentralAccounts));
  if (canSlip && slip.status === 'loading') return null;
  if (canMethods && methods === null) return null;
  return missingStoreBasics(
    canSlip && slip.status === 'ready' ? slip.data : null,
    canMethods ? methods : null,
  );
}
