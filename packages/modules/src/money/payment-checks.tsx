// "Cocokkan mutasi", shared by the phone and the PC: the transfer, QRIS and EDC payments the
// counter took by hand, for an owner to tick off against the bank statement. A payment Xendit
// confirmed is not here, nor a cancelled one. One flagged missing stays, with who took it and who
// flagged it, until it is found (matched) or cancelled.
import { formatDateTime } from '@bolusi/i18n';

import { MONEY_PERMISSION, type PaymentCheckOutcome } from './constants.js';
import { tm } from './i18n.js';
import { accountLabel } from './kas.js';
import type { MoneyEntryRow, PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime } from './runtime.js';
import type { QueryState } from '../screen-kit/index.js';

/** The most `paymentChecks` returns at once; more pages load on demand. */
const PAGE = 200;

export interface PaymentChecks {
  readonly rows: readonly MoneyEntryRow[];
  /** More waiting than the pages read so far. */
  readonly more: boolean;
  readonly customers: ReadonlyMap<string, string>;
  readonly accounts: readonly PaymentAccountRow[];
}

/** Whether this person ticks payments off: the owners, or whom they gave it to. */
export function useMayCheckPayments(): boolean {
  return useMoneyRuntime().hasPermission(MONEY_PERMISSION.checkPayments);
}

const NONE: PaymentChecks = { rows: [], more: false, customers: new Map(), accounts: [] };

/**
 * The payments still to check, oldest first, `pages` pages of them; `nonce` reads them again.
 * Nothing for someone who may not check them, so the board asks nothing it cannot read.
 */
export function usePaymentChecks(pages: number, nonce: number): QueryState<PaymentChecks> {
  const may = useMayCheckPayments();
  return useMoneyQuery<PaymentChecks>(
    async (rt) => {
      if (!may) return NONE;
      const rows: MoneyEntryRow[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < pages; page += 1) {
        const result = await rt.query('paymentChecks', {
          limit: PAGE,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });
        rows.push(...result.rows);
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      const [customers, accounts] = await Promise.all([
        rt.customersOf(
          rows
            .filter((row) => row.documentKind !== null && row.documentId !== null)
            .map((row) => ({ kind: row.documentKind!, id: row.documentId! })),
        ),
        rt
          .query('paymentAccounts', { includeInactive: true })
          .then((result) => result.rows)
          .catch(() => [] as PaymentAccountRow[]),
      ]);
      return { rows, more: cursor !== null && cursor !== undefined, customers, accounts };
    },
    `paymentChecks:${String(may)}:${String(pages)}:${String(nonce)}`,
  );
}

/** How many payments wait for a check, and how many of them were flagged missing. */
export interface PaymentChecksCount {
  readonly open: number;
  readonly missing: number;
  /** More than one page waits: the count is at least `open`. */
  readonly more: boolean;
}

export function checksCount(checks: PaymentChecks): PaymentChecksCount {
  return {
    open: checks.rows.length,
    missing: checks.rows.filter((row) => row.checkedOutcome === 'missing').length,
    more: checks.more,
  };
}

/** One payment as the list shows it: method and amount lead, then when, for whom, by whom. */
export interface CheckLine {
  readonly method: string;
  readonly details: readonly string[];
  /** Flagged missing, and by whom: said in the danger colour, above the answers. */
  readonly missing: string | null;
  /** The answers still open: a payment flagged missing can only be found now. */
  readonly answers: readonly PaymentCheckOutcome[];
}

export function checkLine(
  entry: MoneyEntryRow,
  accounts: readonly PaymentAccountRow[],
  customer: string | null,
): CheckLine {
  const missing = entry.checkedOutcome === 'missing';
  return {
    method: accountLabel(entry.account ?? '', accounts),
    details: [
      formatDateTime(entry.createdAt),
      customer,
      entry.documentLabel,
      entry.reference,
      entry.createdByName === null
        ? null
        : tm('money.checks.takenBy', { name: entry.createdByName }),
    ].filter((part): part is string => part !== null && part !== ''),
    missing: missing
      ? entry.checkedByName === null
        ? tm('money.checks.missing')
        : tm('money.checks.missingBy', { name: entry.checkedByName })
      : null,
    answers: missing ? ['matched'] : ['missing', 'matched'],
  };
}

/** The button for each answer. */
export const CHECK_ANSWER_KEY = {
  matched: 'money.checks.matched',
  missing: 'money.checks.notFound',
} as const satisfies Record<PaymentCheckOutcome, string>;
