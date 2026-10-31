// Identifiers for the `money` module: the store's money ledger (product-scope.md, "Repair
// payments"). Every module that takes or pays money records it here, through these op types, so
// the cash drawer, what a customer still owes and the books come from one place.
//
// Op types are past tense and permission ids present tense, as in every other module.

export const MONEY_MODULE_ID = 'money' as const;

/** One money record: a charge, a payment, a refund, a cash movement or a cash count. */
export const MONEY_ENTRY_ENTITY = 'money_entry' as const;
/** A place money lands other than the drawer: a QRIS, an EDC machine, a bank account. */
export const MONEY_ACCOUNT_ENTITY = 'money_account' as const;

export const MONEY_TABLE = {
  accounts: 'money_accounts',
  entries: 'money_entries',
  lines: 'money_lines',
} as const;

export const MONEY_OP = {
  /** A store's own payment account added or changed. */
  accountSaved: 'money.account_saved',
  /** A payment account shared by the franchise's stores (one central bank or QRIS). */
  centralAccountSaved: 'money.central_account_saved',
  /** What a customer owes for a document (a finished servisan, later a sale) is recorded. */
  chargeRecorded: 'money.charge_recorded',
  /** An owner lowers what a customer owes: a write-off or a refund beyond what was overpaid. */
  chargeReduced: 'money.charge_reduced',
  paymentReceived: 'money.payment_received',
  /** An owner cancels a payment recorded by mistake. */
  paymentVoided: 'money.payment_voided',
  refundPaid: 'money.refund_paid',
  /** Cash taken out of or put into the drawer, with a reason. */
  cashMoved: 'money.cash_moved',
  /** An owner cancels a cash move recorded by mistake (a typo in its amount). */
  cashMoveVoided: 'money.cash_move_voided',
  /** The drawer counted ("Tutup kas"). */
  cashCounted: 'money.cash_counted',
  /** An owner settles a counted difference, so the drawer's book matches the cash again. */
  cashAdjusted: 'money.cash_adjusted',
} as const;
export type MoneyOpType = (typeof MONEY_OP)[keyof typeof MONEY_OP];

/**
 * The split follows the cash-fraud rules (product-scope.md): the counter takes payments, moves and
 * counts cash; only owners lower what a customer owes, give back more than was overpaid, cancel a
 * payment or settle a cash difference.
 */
export const MONEY_PERMISSION = {
  /** See the store's money: payments, the drawer, counts and what customers owe. */
  read: 'money.read',
  /** Record a charge, a payment, and give back what a customer overpaid. */
  receive: 'money.receive',
  /** Refund more than a customer overpaid, or lower what they owe (owners). */
  refund: 'money.refund',
  /** Cancel a payment recorded by mistake (owners). */
  voidPayment: 'money.void_payment',
  /** Take cash out of the drawer or put it in, with a reason. */
  moveCash: 'money.move_cash',
  countCash: 'money.count_cash',
  /** Settle a counted difference (owners). */
  adjustCash: 'money.adjust_cash',
  /** Let a customer take their goods before paying in full, leaving a debt (owners). */
  extendCredit: 'money.extend_credit',
  /** Store-scoped: the store's own QRIS, EDC and bank accounts. */
  manageAccounts: 'money.manage_accounts',
  /** Tenant-scoped: accounts shared by every store. */
  manageCentralAccounts: 'money.manage_central_accounts',
} as const;

/** The drawer of the store that recorded the line. Every store has exactly one. */
export const CASH_ACCOUNT = 'cash' as const;
const PAYMENT_ACCOUNT_PREFIX = 'account:';

/** The ledger account of a configured payment account. */
export function paymentAccountRef(accountId: string): string {
  return `${PAYMENT_ACCOUNT_PREFIX}${accountId}`;
}

/** The configured payment account an account ref names, or null for the drawer and system codes. */
export function paymentAccountIdOf(ref: string): string | null {
  return ref.startsWith(PAYMENT_ACCOUNT_PREFIX) ? ref.slice(PAYMENT_ACCOUNT_PREFIX.length) : null;
}

/**
 * The ledger's own accounts. A line on `receivable` names its document, so one document's balance
 * is a sum: positive while the customer owes, negative while they have paid ahead (a DP).
 * The stock and purchasing accounts are reserved for that module, which posts through here too.
 */
export const SYSTEM_ACCOUNT = {
  receivable: 'receivable',
  serviceRevenue: 'service_revenue',
  cancelFeeRevenue: 'cancel_fee_revenue',
  /** What owners took off customers' bills after they were charged (contra revenue). */
  revenueAdjustment: 'revenue_adjustment',
  cashOverShort: 'cash_over_short',
  ownerDraw: 'owner_draw',
  ownerCapital: 'owner_capital',
  expense: 'expense',
  // Reserved for parts, stock and purchasing.
  inventory: 'inventory',
  partsOnOrder: 'parts_on_order',
  cogs: 'cogs',
  payable: 'payable',
  purchaseReturns: 'purchase_returns',
} as const;

/** The revenue accounts a charge may credit. */
export const REVENUE_ACCOUNTS = [
  SYSTEM_ACCOUNT.serviceRevenue,
  SYSTEM_ACCOUNT.cancelFeeRevenue,
] as const;
export type RevenueAccount = (typeof REVENUE_ACCOUNTS)[number];

/** Configured accounts. Cash is never configured: it is each store's drawer. */
export const PAYMENT_ACCOUNT_KINDS = ['qris', 'edc', 'transfer'] as const;
export type PaymentAccountKind = (typeof PAYMENT_ACCOUNT_KINDS)[number];

/** EDC slips carry an approval code, the one thing that ties the payment to the bank's record. */
export function referenceRequired(kind: PaymentAccountKind | 'cash'): boolean {
  return kind === 'edc';
}

/**
 * Why cash leaves or enters the drawer other than a sale or refund:
 * `withdrawal` an owner takes the takings ("Setor ke pemilik"), `expense` a small store cost,
 * `deposit` cash paid into one of the store's bank accounts, `float` change money put in.
 */
export const CASH_MOVE_KINDS = ['withdrawal', 'expense', 'deposit', 'float'] as const;
export type CashMoveKind = (typeof CASH_MOVE_KINDS)[number];

/** Whether a move takes cash out of the drawer (everything but change money put in). */
export function movesOut(kind: CashMoveKind): boolean {
  return kind !== 'float';
}

/** The largest rupiah amount one money record may carry. */
export const MAX_AMOUNT = 1_000_000_000_000;
export const MAX_REASON = 500;
export const MAX_REFERENCE = 100;
export const MAX_DOCUMENT_LABEL = 80;
export const MAX_ACCOUNT_NAME = 60;

/**
 * The reason a refund made at handover records: a code, so the history reads it in each reader's
 * language (`historyLine`) rather than in the words of the device that saved it.
 */
export const HANDOVER_REFUND_REASON = 'handover_refund';

/** What an entry is, on its row: the op type without the module prefix. */
export const ENTRY_KINDS = [
  'charge_recorded',
  'charge_reduced',
  'payment_received',
  'refund_paid',
  'cash_moved',
  'cash_counted',
  'cash_adjusted',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
