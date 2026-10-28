// The money ledger in memory, for the preview and the screen harnesses: the store's methods, the
// drawer with today's payments and moves, a count an owner still has to settle and one customer
// who took their phone before paying. Commands do what the real ones do to the figures the Kas
// screens read; rules and postings are the real module's job and are tested there. Its QRIS method
// is connected to a Xendit test account (`demoQris`), so the QR can be shown and "paid".
import {
  QRIS_TTL_MS,
  type QrisCharge,
  type QrisChargeBody,
  type QrisConnection,
} from '@bolusi/schemas';

import { CASH_ACCOUNT, type CashMoveKind, type EntryKind } from './constants.js';
import { movesOut } from './kas.js';
import { MONEY_REFUSALS } from './rules.js';
import type { MoneyDocument } from './documents.js';
import { QrisError, type QrisPort } from './qris.js';
import type {
  CashCountRow,
  CashDrawer,
  DocumentMoney,
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
  /** Whether they give back beyond an overpayment (an owner); the counter by default. */
  readonly mayRefund?: (() => boolean) | undefined;
  /** A finished servisan the customer took home unpaid. */
  readonly debt?:
    { readonly id: string; readonly label: string; readonly amount: number } | undefined;
}

export interface DemoMoneyLedger {
  query(name: string, input: Input): Promise<{ rows: unknown[]; nextCursor: null }>;
  run(name: string, input: Input): Promise<unknown>;
  /**
   * A payment the server would record (a paid QR), or one a servisan's handover took, under the id
   * it was made with; `at` when it was not just now.
   */
  recordPayment(payment: {
    readonly id: string;
    readonly document: MoneyDocument;
    readonly account: string;
    readonly amount: number;
    readonly at?: number | undefined;
  }): void;
  /** What a document charges once it is settled (a servisan handed back). */
  recordCharge(charge: {
    readonly document: MoneyDocument;
    readonly amount: number;
    readonly at?: number | undefined;
  }): void;
  /** One document's money, as `documentMoney` reads it; null for a document it never saw. */
  documentMoney(documentId: string): DocumentMoney | null;
}

/** An entry as the ledger stores it, with the debt it settles when it is one. */
interface Stored extends MoneyEntryRow {
  readonly relatedEntryId: string | null;
}

export function demoMoneyLedger(options: DemoMoneyOptions, notify: () => void): DemoMoneyLedger {
  const { now } = options;
  // Settings adds, renames and switches off methods; the payment step offers the ones in use.
  const accounts: PaymentAccountRow[] = [...options.accounts];
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
  const cashNow = (): number => entries.reduce((sum, e) => sum + cashEffect(e), 0);
  /** As `countExpected`: a correction that settled an earlier count stands at that count. */
  const countExpected = (count: Stored): number =>
    entries
      .filter((e) => {
        const settles = e.kind === 'cash_adjusted' ? byId(e.relatedEntryId) : undefined;
        return settles === undefined ? e.createdAt < count.createdAt : earlier(settles, count);
      })
      .reduce((sum, e) => sum + cashEffect(e), 0);
  const byId = (id: string | null): Stored | undefined =>
    id === null ? undefined : entries.find((e) => e.id === id);
  const earlier = (a: Stored, b: Stored): boolean =>
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);

  const drawer = (): CashDrawer => {
    const counts: CashCountRow[] = entries
      .filter((e) => e.kind === 'cash_counted')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((count) => {
        const expected = countExpected(count);
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
    return { expected: cashNow(), counts };
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
              : e.kind === 'charge_reduced'
                ? -1
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

  const documentMoney = (documentId: string): DocumentMoney | null => {
    const mine = entries.filter((e) => e.documentId === documentId);
    if (mine.length === 0) return null;
    const total = (kind: EntryKind) =>
      mine
        .filter((e) => e.kind === kind && e.voidedAt === null)
        .reduce((sum, e) => sum + e.amount, 0);
    const charged = total('charge_recorded');
    const reduced = total('charge_reduced');
    const paid = total('payment_received') - total('refund_paid');
    return { balance: charged - reduced - paid, charged, reduced, paid, entries: mine };
  };

  const add = (fields: Partial<Stored> & { kind: EntryKind; amount: number }): string => {
    // After the seeded records, in the order they were made: the preview's clock stands still.
    const created = entry({ createdBy: options.actor(), createdAt: now + ids, ...fields });
    entries.push(created);
    notify();
    return created.id;
  };

  const page = (rows: unknown[]) => Promise.resolve({ rows, nextCursor: null });
  return {
    documentMoney,
    recordPayment: ({ id, document: doc, account, amount, at }) => {
      add({
        id,
        kind: 'payment_received',
        account,
        amount,
        documentKind: doc.kind,
        documentId: doc.id,
        documentLabel: doc.label,
        ...(at === undefined ? {} : { createdAt: at }),
      });
    },
    recordCharge: ({ document: doc, amount, at }) => {
      add({
        kind: 'charge_recorded',
        amount,
        documentKind: doc.kind,
        documentId: doc.id,
        documentLabel: doc.label,
        ...(at === undefined ? {} : { createdAt: at }),
      });
    },
    query: (name, input) => {
      switch (name) {
        case 'documentMoney': {
          const found = documentMoney(String(input['id']));
          return page(
            found === null
              ? [{ balance: 0, charged: 0, reduced: 0, paid: 0, entries: [] }]
              : [found],
          );
        }
        case 'paymentAccounts':
          return page(accounts.filter((row) => input['includeInactive'] === true || row.active));
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
        case 'refund': {
          // As refundHandler: an owner giving back beyond the overpayment lowers the bill first.
          const doc = input['document'] as MoneyDocument;
          const amount = Number(input['amount']);
          const money = documentMoney(doc.id);
          const credit = Math.max(0, -(money?.balance ?? 0));
          // Refused as the rules refuse it, so the preview never shows what a store cannot do.
          if (money === null || amount > credit + money.charged - money.reduced) {
            return Promise.reject(
              MONEY_REFUSALS.refuse('refundAbovePaid', { code: 'VALIDATION_FAILED' }),
            );
          }
          const fields = {
            reason: String(input['reason']),
            documentKind: doc.kind,
            documentId: doc.id,
            documentLabel: doc.label,
          };
          if (amount > credit) {
            if (options.mayRefund?.() !== true) {
              return Promise.reject(
                MONEY_REFUSALS.refuse('refundAboveCredit', { code: 'PERMISSION_DENIED' }),
              );
            }
            add({ kind: 'charge_reduced', amount: amount - credit, ...fields });
          }
          add({
            kind: 'refund_paid',
            account: String(input['account']),
            amount,
            reference: (input['reference'] as string | null) ?? null,
            ...fields,
          });
          return Promise.resolve(null);
        }
        case 'reduceCharge': {
          const doc = input['document'] as MoneyDocument;
          const money = documentMoney(doc.id);
          if (options.mayRefund?.() !== true) {
            // The command itself needs `money.refund`, as the runtime checks before any rule.
            return Promise.reject(
              Object.assign(new Error('permission'), { code: 'PERMISSION_DENIED' }),
            );
          }
          if (money === null || Number(input['amount']) > money.charged - money.reduced) {
            return Promise.reject(
              MONEY_REFUSALS.refuse('aboveCharged', { code: 'VALIDATION_FAILED' }),
            );
          }
          add({
            kind: 'charge_reduced',
            amount: Number(input['amount']),
            reason: String(input['reason']),
            documentKind: doc.kind,
            documentId: doc.id,
            documentLabel: doc.label,
          });
          return Promise.resolve(null);
        }
        case 'saveAccount':
        case 'saveCentralAccount': {
          const accountId = (input['accountId'] as string | undefined) ?? `a-${String((ids += 1))}`;
          const saved: PaymentAccountRow = {
            id: accountId,
            kind: input['kind'] as PaymentAccountRow['kind'],
            name: String(input['name']),
            active: input['active'] !== false,
            central: name === 'saveCentralAccount',
            storeIds: (input['storeIds'] as string[] | undefined) ?? [],
          };
          const at = accounts.findIndex((row) => row.id === accountId);
          if (at === -1) accounts.push(saved);
          else accounts[at] = saved;
          accounts.sort((a, b) => a.name.localeCompare(b.name));
          notify();
          return Promise.resolve({ accountId });
        }
        case 'voidPayment': {
          const at = entries.findIndex((e) => e.id === input['entryId']);
          if (at !== -1) {
            entries[at] = {
              ...entries[at]!,
              voidedBy: options.actor(),
              voidedAt: now + ids,
              voidReason: String(input['reason']),
            };
            ids += 1;
            notify();
          }
          return Promise.resolve(null);
        }
        default:
          return Promise.resolve(null);
      }
    },
  };
}

/**
 * QRIS through a pretend Xendit test account: `connectedAccounts` start connected, a QR waits until
 * "Bayar (mode uji)" pays it, and the payment lands through `onPaid` as the server would record it.
 */
export function demoQris(options: {
  readonly now: () => number;
  readonly connectedAccounts: readonly string[];
  readonly onPaid: (body: QrisChargeBody) => void;
}): QrisPort {
  const connections = new Map<string, QrisConnection>(
    options.connectedAccounts.map((accountId) => [
      accountId,
      { accountId, environment: 'test', connectedAt: options.now() },
    ]),
  );
  const charges = new Map<string, { body: QrisChargeBody; charge: QrisCharge }>();
  const current = (id: string): QrisCharge => {
    const found = charges.get(id);
    if (found === undefined) throw new QrisError('notFound');
    const { charge } = found;
    return charge.status === 'waiting' && charge.expiresAt <= options.now()
      ? { ...charge, status: 'expired' }
      : charge;
  };
  return {
    connections: () => Promise.resolve([...connections.values()]),
    connect: (accountId, secretKey) => {
      const connection: QrisConnection = {
        accountId,
        environment: secretKey.startsWith('xnd_development_') ? 'test' : 'live',
        connectedAt: options.now(),
      };
      connections.set(accountId, connection);
      return Promise.resolve(connection);
    },
    disconnect: (accountId) => {
      connections.delete(accountId);
      return Promise.resolve();
    },
    createCharge: (body) => {
      const known = charges.get(body.id);
      if (known !== undefined) return Promise.resolve(current(body.id));
      const connection = connections.get(body.accountId);
      if (connection === undefined) return Promise.reject(new QrisError('notConnected'));
      const charge: QrisCharge = {
        id: body.id,
        status: 'waiting',
        amount: body.amount,
        // Xendit's test mode answers with a placeholder rather than a payable QRIS string.
        qrString: `DEMO-QRIS-${body.document.label}-${String(body.amount)}-${body.id}`,
        environment: connection.environment,
        expiresAt: options.now() + QRIS_TTL_MS,
        paidAt: null,
      };
      charges.set(body.id, { body, charge });
      return Promise.resolve(charge);
    },
    charge: (id) => {
      try {
        return Promise.resolve(current(id));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    simulate: (id) => {
      const found = charges.get(id);
      if (found === undefined) return Promise.reject(new QrisError('notFound'));
      if (found.charge.status !== 'paid') {
        found.charge = { ...found.charge, status: 'paid', paidAt: options.now() };
        options.onPaid(found.body);
      }
      return Promise.resolve(found.charge);
    },
  };
}
