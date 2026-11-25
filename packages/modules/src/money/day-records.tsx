// Riwayat's read, shared by the phone and the PC: one day's money records, newest first, with the
// customer each is for and the methods' names, a page at a time.
import { dayStart, inHistory } from './kas.js';
import type { MoneyKey } from './i18n.js';
import type { MoneyEntryRow, PaymentAccountRow } from './queries.js';
import { useMoneyQuery } from './runtime.js';
import type { QueryState } from '../screen-kit/index.js';

/** The most `moneyEntries` returns at once: a day rarely needs a second page. */
const PAGE = 500;

/** Local midnight `days` days from the day starting at `day`, whatever the clock change. */
export function shiftDay(day: number, days: number): number {
  const date = new Date(day);
  date.setDate(date.getDate() + days);
  return dayStart(date.getTime());
}

/** Riwayat with nothing in it: today may still get some, a past day is done. */
export function historyEmptyKey(day: number, today: number): MoneyKey {
  return day >= today ? 'money.history.none' : 'money.history.noneDay';
}

export interface DayRecords {
  readonly rows: readonly MoneyEntryRow[];
  /** More records than the pages read so far. */
  readonly more: boolean;
  readonly customers: ReadonlyMap<string, string>;
  readonly accounts: readonly PaymentAccountRow[];
}

/** The records of the day starting at `day`, `pages` pages of them; `nonce` reads them again. */
export function useDayRecords(day: number, pages: number, nonce: number): QueryState<DayRecords> {
  return useMoneyQuery<DayRecords>(
    async (rt) => {
      const rows: MoneyEntryRow[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < pages; page += 1) {
        const result = await rt.query('moneyEntries', {
          from: day,
          to: shiftDay(day, 1),
          limit: PAGE,
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        });
        rows.push(...result.rows.filter(inHistory));
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      const [customers, accounts] = await Promise.all([
        rt.customersOf(
          rows
            .filter((row) => row.documentKind !== null && row.documentId !== null)
            .map((row) => ({ kind: row.documentKind!, id: row.documentId! })),
        ),
        // Method names; someone who cannot take payments reads the records without them.
        rt
          .query('paymentAccounts', { includeInactive: true })
          .then((result) => result.rows)
          .catch(() => [] as PaymentAccountRow[]),
      ]);
      return { rows, more: cursor !== null && cursor !== undefined, customers, accounts };
    },
    `history:${String(day)}:${String(pages)}:${String(nonce)}`,
  );
}
