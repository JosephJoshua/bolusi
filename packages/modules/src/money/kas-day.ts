// The Kas board's reads, shared by the phone and the PC: the drawer, the day's records, the
// store's methods and what customers owe, each live, and the figures the board shows from them.
import { useState } from 'react';

import type { QueryState } from '../screen-kit/index.js';

import { MONEY_PERMISSION } from './constants.js';
import {
  countToday,
  dayStart,
  differenceToSettle,
  drawerMoves,
  moneyIn,
  nameBalances,
  seesExpected,
  splitOpenBalances,
  type DrawerMove,
  type MoneyIn,
  type NamedBalance,
  type OpenBalances,
} from './kas.js';
import type { CashCountRow, CashDrawer, MoneyEntryRow, PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime } from './runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A read this person may not make shows nothing, rather than a locked section. */
function readyOr<T>(query: QueryState<T>): T | null {
  return query.status === 'ready' ? query.data : null;
}

export interface KasDay {
  /** The drawer read itself, for its loading state. */
  readonly drawerQuery: QueryState<CashDrawer>;
  readonly drawer: CashDrawer | null;
  readonly accounts: readonly PaymentAccountRow[];
  /** The day's records have loaded (and this person may read them). */
  readonly entriesReady: boolean;
  readonly moneyIn: MoneyIn;
  readonly moves: readonly DrawerMove[];
  readonly open: OpenBalances<NamedBalance>;
  /** The latest count's difference an owner still has to settle. */
  readonly difference: CashCountRow | null;
  /** Today's count, when the drawer was counted today. */
  readonly counted: CashCountRow | null;
  /** Reads it all again, after a read failed. */
  readonly retry: () => void;
  readonly may: {
    readonly read: boolean;
    readonly count: boolean;
    readonly move: boolean;
    readonly settle: boolean;
    /** Sees what should be in the drawer; otherwise counts blind (`seesExpected`). */
    readonly seeExpected: boolean;
    readonly receive: boolean;
  };
}

export function useKasDay(now: () => number): KasDay {
  const runtime = useMoneyRuntime();
  const can = (permission: string) => runtime.hasPermission(permission);
  // Read each render, so a board shown again the next morning reads the new day.
  const today = dayStart(now());
  const [nonce, setNonce] = useState(0);
  const again = `:${String(nonce)}`;
  const drawerQuery = useMoneyQuery(
    async (rt) => (await rt.query('cashDrawer', {})).rows[0]!,
    `drawer${again}`,
  );
  const entries = useMoneyQuery(
    async (rt) => {
      // Every record of the day, however busy it was: the totals are sums over all of them.
      const rows: MoneyEntryRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await rt.query('moneyEntries', {
          from: today,
          to: today + DAY_MS,
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    },
    `entries:${String(today)}${again}`,
  );
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', { includeInactive: true })).rows,
    `accounts${again}`,
  );
  const balances = useMoneyQuery(async (rt) => {
    const { rows } = await rt.query('openBalances', {});
    return nameBalances(
      rows,
      await rt.customersOf(rows.map((row) => ({ kind: row.documentKind, id: row.documentId }))),
    );
  }, `open${again}`);

  const drawer = readyOr(drawerQuery);
  const todayEntries = readyOr(entries) ?? [];
  return {
    drawerQuery,
    drawer,
    accounts: readyOr(accounts) ?? [],
    entriesReady: entries.status === 'ready',
    moneyIn: moneyIn(todayEntries),
    moves: drawerMoves(todayEntries),
    open: splitOpenBalances(readyOr(balances) ?? []),
    difference: drawer === null ? null : differenceToSettle(drawer.counts),
    counted: drawer === null ? null : countToday(drawer.counts, now()),
    retry: () => setNonce((n) => n + 1),
    may: {
      read: can(MONEY_PERMISSION.read),
      count: can(MONEY_PERMISSION.countCash),
      move: can(MONEY_PERMISSION.moveCash),
      settle: can(MONEY_PERMISSION.adjustCash),
      // Who counts blind does not see the drawer's figure here either, or the count would copy it.
      seeExpected: seesExpected(can, (permission) => runtime.limitOf(permission)),
      receive: can(MONEY_PERMISSION.receive),
    },
  };
}
