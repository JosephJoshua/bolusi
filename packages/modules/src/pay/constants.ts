// Identifiers for the `pay` module: what the business pays its staff (product-scope.md, "Staff
// pay"). A fixed monthly salary, commission on servisan, kasbon (advances), and one payout per
// person per month. Payroll with BPJS and PPh 21 builds on these records later.
//
// Two readers, two sets of records. Kasbon is what an owner or a Manajer hands out and takes back,
// so it is read with "Kasbon" (`pay.advances`). Salaries, commission and payouts are the owners'
// (`pay.read`). A payout's kasbon installment is recorded as a kasbon repayment of its own, so
// whoever keeps kasbon sees every rupiah that came off a balance without seeing anyone's salary.

export const PAY_MODULE_ID = 'pay' as const;

/** One employee's pay terms at one store: their salary and their commission rate. Id = user id. */
export const PAY_EMPLOYEE_ENTITY = 'pay_employee' as const;
/** A store's commission setting. Id = store id. */
export const PAY_STORE_ENTITY = 'pay_store' as const;
/** One kasbon handed out. */
export const PAY_ADVANCE_ENTITY = 'pay_advance' as const;
/** Kasbon coming back: paid into Kas, taken off a payout, or written off. */
export const PAY_REPAYMENT_ENTITY = 'pay_repayment' as const;
/** One month's pay to one person. */
export const PAY_PAYOUT_ENTITY = 'pay_payout' as const;
/** Commission an owner added or took off by hand, with a reason. */
export const PAY_ADJUSTMENT_ENTITY = 'pay_adjustment' as const;

export const PAY_TABLE = {
  terms: 'pay_terms',
  storeRates: 'pay_store_rates',
  advances: 'pay_advances',
  repayments: 'pay_repayments',
  payouts: 'pay_payouts',
  adjustments: 'pay_adjustments',
} as const;

export const PAY_OP = {
  /** An owner sets someone's monthly salary and commission rate (null: the store's). */
  termsSet: 'pay.terms_set',
  /** An owner turns commission on at a store with a percentage, or off (null). */
  storeCommissionSet: 'pay.store_commission_set',
  advanceGranted: 'pay.advance_granted',
  /** Kasbon back into Kas, off a payout (`salary`), or written off by an owner. */
  advanceSettled: 'pay.advance_settled',
  /** A repayment cancelled: with its payout, or one recorded by mistake. */
  repaymentVoided: 'pay.repayment_voided',
  /** A kasbon cancelled: handed out by mistake, before anything came back off it. */
  advanceVoided: 'pay.advance_voided',
  /** A month's pay: salary + commission − installment, from a drawer or a bank account. */
  salaryPaid: 'pay.salary_paid',
  payoutVoided: 'pay.payout_voided',
  commissionAdjusted: 'pay.commission_adjusted',
} as const;

/** Kasbon above a Manajer's store limit, asked of an owner (approvals). */
export const PAY_APPROVAL_KIND = { advance: 'pay.advance' } as const;

export const PAY_PERMISSION = {
  /** Each person's own pay statement. Every role holds it. */
  own: 'pay.own',
  /** Everyone's salaries, commission and payouts at the store. */
  read: 'pay.read',
  /** Kasbon: see the balances, hand one out, take a repayment. */
  advances: 'pay.advances',
  /** "Bayar gaji": pay someone their month. */
  pay: 'pay.pay',
  /** Salaries, commission rates, commission by hand, writing kasbon off. Owners only. */
  manage: 'pay.manage',
} as const;

/** How kasbon came back: through a payment account, off a payout, or written off by an owner. */
export const SALARY_REPAYMENT = 'salary' as const;
export const WRITTEN_OFF = 'written_off' as const;

/** The highest commission rate, in percent. */
export const MAX_COMMISSION_PERCENT = 100;
/** The largest rupiah amount one pay record may carry. */
export const MAX_PAY_AMOUNT = 10_000_000_000;
export const MAX_PAY_NOTE = 500;

/** A month as payouts name it: `2026-11`. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
