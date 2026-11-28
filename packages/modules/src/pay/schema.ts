// The dialect-neutral shape the `pay` appliers and queries are typed against, as repair's
// schema.ts: no boolean columns, times are ms epoch integers, money is integer IDR. Column order is
// the DDL order in both migrations and the manifest.
//
// Terms and rates are kept as history, one row per change: commission is worked out at the rate in
// force when it was earned, so a rate changed mid-month does not rewrite what was already earned.

/** One change to an employee's terms at a store. Keyed by the op; the entity is the employee. */
export interface PayTermsTable {
  id: string;
  tenantId: string;
  storeId: string;
  userId: string;
  /** Integer IDR a month. */
  salary: number;
  /** Their own commission rate in percent, or null for the store's. */
  commissionPercent: number | null;
  setBy: string;
  setAt: number;
}

/** One change to a store's commission. Keyed by the op; the entity is the store. */
export interface PayStoreRatesTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** Percent, or null: commission off at this store. */
  commissionPercent: number | null;
  setBy: string;
  setAt: number;
}

export interface PayAdvancesTable {
  id: string;
  tenantId: string;
  storeId: string;
  userId: string;
  amount: number;
  /** The payment account it was paid from (`cash`, `account:<id>`). */
  account: string;
  reason: string;
  /** What comes off each month's pay, as agreed when it was given. */
  installment: number;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

export interface PayRepaymentsTable {
  id: string;
  tenantId: string;
  storeId: string;
  userId: string;
  amount: number;
  /** A payment account (`cash`, `account:<id>`), `salary` (off a payout) or `written_off`. */
  via: string;
  /** The payout it came off, for `salary`. */
  payoutId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

export interface PayPayoutsTable {
  id: string;
  tenantId: string;
  storeId: string;
  userId: string;
  /** `2026-11`: one payout per person per month. */
  month: string;
  salary: number;
  /** Commission paid with it; negative when take-backs came off the salary. */
  commission: number;
  /** Kasbon taken off it (its repayment is `repaymentId`). */
  deduction: number;
  repaymentId: string | null;
  /** salary + commission − deduction: what left the account. */
  paid: number;
  account: string;
  note: string | null;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

export interface PayAdjustmentsTable {
  id: string;
  tenantId: string;
  storeId: string;
  userId: string;
  /** Signed integer IDR: added (positive) or taken off (negative). */
  amount: number;
  reason: string;
  createdBy: string;
  createdAt: number;
}

export interface PayDatabase {
  payTerms: PayTermsTable;
  payStoreRates: PayStoreRatesTable;
  payAdvances: PayAdvancesTable;
  payRepayments: PayRepaymentsTable;
  payPayouts: PayPayoutsTable;
  payAdjustments: PayAdjustmentsTable;
}
