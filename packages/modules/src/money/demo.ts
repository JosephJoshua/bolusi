// The money ledger in memory, for the preview and the screen harnesses: the store's methods, the
// drawer with today's payments and moves, a count an owner still has to settle and one customer
// who took their phone before paying. Commands do what the real ones do to the figures the Kas
// screens read; rules and postings are the real module's job and are tested there.
import { CASH_ACCOUNT, type CashMoveKind, type EntryKind } from './constants.js';
import { movesOut } from './kas.js';
import type {
  CashCountRow,
  CashDrawer,
  MoneyEntryRow,
  OpenBalanceRow,
  PaymentAccountRow,
} from './queries.js';

type Input = Record<string, unknown>;
const HOUR = 60 * 60 * 1000;

export interface DemoMoneyOptions {
  readonly now: number;
  readonly accounts: readonly PaymentAccountRow[];
  /** Who records the next entry. */
  readonly actor: () => string;
  /** A finished servisan the customer took home unpaid. */
  readonly debt?: { readonly id: string; readonly label: string; readonly amount: number };
}

export interface DemoMoneyLedger {
  query(name: string, input: Input): Promise<{ rows: unknown[]; nextCursor: null }>;
  run(name: string, input: Input): Promise<unknown>;
}

/** An entry as the ledger stores it, with the debt it settles when it is one. */
interface Stored extends MoneyEntryRow {
  readonly relatedEntryId: string | null;
}

export function demoMoneyLedger(options: DemoMoneyOptions, notify: () => void): DemoMoneyLedger {
  const { now, accounts } = options;
  let ids = 0;
  const entry = (fields: Partial<Stored> & { kind: EntryKind; amount: number }): Stored => ({
    id: `m-${String((ids += 1))}`,
    account: null,
    subKind: null,
    reference: null,
    reason: null,
    tendered: null,
    documentKind: null,
    documentId: null,
    documentLabel: null,
    createdBy: 'u-siti',
    createdAt: now,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    relatedEntryId: null,
    ...fields,
  });
  const qris = accounts.find((row) => row.kind === 'qris');
  const document = (id: string, label: string) => ({
    documentKind: 'repair.ticket',
    documentId: id,
    documentLabel: label,
  });
  const entries: Stored[] = [
    entry({ kind: 'cash_moved', subKind: 'float', amount: 200_000, reason: 'Modal kembalian' }),
    entry({ kind: 'cash_counted', amount: 190_000, createdAt: now - 14 * HOUR }),
    entry({
      kind: 'payment_received',
      account: CASH_ACCOUNT,
      amount: 350_000,
      createdAt: now - 3 * HOUR,
      ...document('t-demo-a', 'K7Q-0103'),
    }),
    entry({
      kind: 'payment_received',
      account: qris === undefined ? CASH_ACCOUNT : `account:${qris.id}`,
      amount: 150_000,
      createdAt: now - 2 * HOUR,
      ...document('t-demo-b', 'K7Q-0104'),
    }),
    entry({
      kind: 'cash_moved',
      subKind: 'expense',
      amount: 25_000,
      reason: 'Bensin antar sparepart',
      createdAt: now - HOUR,
    }),
  ];
  // The float came in before last night's count, which found 10.000 short.
  entries[0] = { ...entries[0]!, createdAt: now - 20 * HOUR };
  if (options.debt !== undefined) {
    entries.push(
      entry({
        kind: 'charge_recorded',
        amount: options.debt.amount,
        createdAt: now - 26 * HOUR,
        ...document(options.debt.id, options.debt.label),
      }),
    );
  }

  /** The drawer's change from one entry. */
  const cashEffect = (e: Stored): number => {
    if (e.kind === 'payment_received' && e.account === CASH_ACCOUNT && e.voidedAt === null) {
      return e.amount;
    }
    if (e.kind === 'refund_paid' && e.account === CASH_ACCOUNT) return -e.amount;
    if (e.kind === 'cash_moved') return movesOut(e.subKind as CashMoveKind) ? -e.amount : e.amount;
    if (e.kind === 'cash_adjusted') return e.amount;
    return 0;
  };
  const cashBefore = (at: number | null): number =>
    entries
      .filter((e) => at === null || e.createdAt < at)
      .reduce((sum, e) => sum + cashEffect(e), 0);

  const drawer = (): CashDrawer => {
    const counts: CashCountRow[] = entries
      .filter((e) => e.kind === 'cash_counted')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((count) => {
        const expected = cashBefore(count.createdAt);
        return {
          id: count.id,
          counted: count.amount,
          expected,
          difference: count.amount - expected,
          note: count.reason,
          countedBy: count.createdBy,
          countedAt: count.createdAt,
          settled: entries
            .filter((e) => e.kind === 'cash_adjusted' && e.relatedEntryId === count.id)
            .reduce((sum, e) => sum + e.amount, 0),
        };
      });
    return { expected: cashBefore(null), counts };
  };

  const openBalances = (): OpenBalanceRow[] => {
    const byDocument = new Map<string, OpenBalanceRow>();
    for (const e of entries) {
      if (e.documentId === null) continue;
      const sign =
        e.kind === 'charge_recorded'
          ? 1
          : e.kind === 'payment_received' && e.voidedAt === null
            ? -1
            : e.kind === 'refund_paid'
              ? 1
              : 0;
      const row = byDocument.get(e.documentId);
      const charged = e.kind === 'charge_recorded';
      byDocument.set(e.documentId, {
        documentKind: e.documentKind ?? '',
        documentId: e.documentId,
        documentLabel: e.documentLabel ?? '',
        balance: (row?.balance ?? 0) + sign * e.amount,
        since: charged ? e.createdAt : (row?.since ?? Number.NaN),
      });
    }
    return [...byDocument.values()].filter((row) => !Number.isNaN(row.since) && row.balance !== 0);
  };

  const add = (fields: Partial<Stored> & { kind: EntryKind; amount: number }): string => {
    // After the seeded records, in the order they were made: the preview's clock stands still.
    const created = entry({ ...fields, createdBy: options.actor(), createdAt: now + ids });
    entries.push(created);
    notify();
    return created.id;
  };

  const page = (rows: unknown[]) => Promise.resolve({ rows, nextCursor: null });
  return {
    query: (name, input) => {
      switch (name) {
        case 'paymentAccounts':
          return page([...accounts]);
        case 'cashDrawer':
          return page([drawer()]);
        case 'openBalances':
          return page(openBalances());
        case 'moneyEntries': {
          const from = Number(input['from']);
          const to = Number(input['to']);
          return page(
            entries
              .filter((e) => e.createdAt >= from && e.createdAt < to)
              .sort((a, b) => b.createdAt - a.createdAt),
          );
        }
        default:
          return page([]);
      }
    },
    run: (name, input) => {
      switch (name) {
        case 'moveCash': {
          const entryId = add({
            kind: 'cash_moved',
            subKind: input['kind'] as CashMoveKind,
            amount: Number(input['amount']),
            reason: String(input['reason']),
            account: (input['account'] as string | null) ?? null,
          });
          return Promise.resolve({ entryId });
        }
        case 'countCash': {
          const entryId = add({
            kind: 'cash_counted',
            amount: Number(input['counted']),
            reason: String(input['note'] ?? ''),
          });
          return Promise.resolve({ entryId });
        }
        case 'adjustCash': {
          const entryId = add({
            kind: 'cash_adjusted',
            amount: Number(input['amount']),
            reason: String(input['reason']),
            relatedEntryId: (input['countId'] as string | null) ?? null,
          });
          return Promise.resolve({ entryId });
        }
        case 'receivePayments': {
          const doc = input['document'] as { kind: string; id: string; label: string };
          for (const payment of input['payments'] as { account: string; amount: number }[]) {
            add({
              kind: 'payment_received',
              account: payment.account,
              amount: payment.amount,
              documentKind: doc.kind,
              documentId: doc.id,
              documentLabel: doc.label,
            });
          }
          return Promise.resolve(null);
        }
        default:
          return Promise.resolve(null);
      }
    },
  };
}
