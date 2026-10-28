// The Kas arithmetic the phone and the PC share: money in by method, counts left to settle, today's
// count and what customers owe or are owed.
import { formatMoney, initI18n } from '@bolusi/i18n';
import { beforeAll, describe, expect, test } from 'vitest';

import enCatalog from '../money/i18n/en.json' with { type: 'json' };
import idCatalog from '../money/i18n/id.json' with { type: 'json' };
import { registerMoneyCatalog } from '../src/money/i18n.js';

import {
  countToday,
  dayStart,
  moneyInByMethod,
  differenceToSettle,
  drawerMoves,
  historyLine,
  splitOpenBalances,
  voidable,
} from '../src/money/kas.js';
import type {
  CashCountRow,
  MoneyEntryRow,
  OpenBalanceRow,
  PaymentAccountRow,
} from '../src/money/queries.js';

function entry(overrides: Partial<MoneyEntryRow>): MoneyEntryRow {
  return {
    id: 'e',
    kind: 'payment_received',
    account: 'cash',
    amount: 0,
    subKind: null,
    reference: null,
    reason: null,
    tendered: null,
    documentKind: 'repair.ticket',
    documentId: 'd',
    documentLabel: 'B7B-0001',
    createdBy: 'u',
    createdAt: 0,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  };
}

function count(overrides: Partial<CashCountRow>): CashCountRow {
  return {
    id: 'c',
    counted: 0,
    expected: 0,
    difference: 0,
    note: null,
    countedBy: 'u',
    countedAt: 0,
    settled: 0,
    ...overrides,
  };
}

describe('money in by method', () => {
  test('payments that still count, less refunds, the drawer first', () => {
    const totals = moneyInByMethod([
      entry({ account: 'account:qris', amount: 300_000 }),
      entry({ account: 'cash', amount: 100_000 }),
      entry({ account: 'cash', amount: 50_000 }),
      entry({ kind: 'refund_paid', account: 'cash', amount: 20_000 }),
      entry({ account: 'account:edc', amount: 900_000, voidedAt: 5 }),
      entry({ kind: 'charge_recorded', account: null, amount: 750_000 }),
      entry({ kind: 'cash_moved', subKind: 'expense', account: null, amount: 10_000 }),
    ]);
    expect(totals).toEqual([
      { account: 'cash', amount: 130_000 },
      { account: 'account:qris', amount: 300_000 },
    ]);
  });

  test('a method whose money all went back is left out', () => {
    expect(
      moneyInByMethod([
        entry({ account: 'cash', amount: 50_000 }),
        entry({ kind: 'refund_paid', account: 'cash', amount: 50_000 }),
      ]),
    ).toEqual([]);
  });
});

describe('counts', () => {
  test('only the latest count is left to settle: it finds an earlier difference again', () => {
    const short = count({ id: 'short', difference: -10_000, countedAt: 1 });
    const again = count({ id: 'again', difference: -10_000, countedAt: 2 });
    expect(differenceToSettle([again, short])?.id).toBe('again');
    expect(differenceToSettle([count({ id: 'exact', countedAt: 3 }), again, short])).toBeNull();
    expect(differenceToSettle([{ ...again, settled: -10_000 }])).toBeNull();
    expect(differenceToSettle([])).toBeNull();
  });

  test("today's count is one made since local midnight", () => {
    const now = new Date(2026, 9, 28, 18, 0).getTime();
    expect(dayStart(now)).toBe(new Date(2026, 9, 28).getTime());
    const yesterday = count({ id: 'y', countedAt: new Date(2026, 9, 27, 21, 0).getTime() });
    expect(countToday([yesterday], now)).toBeNull();
    const today = count({ id: 't', countedAt: new Date(2026, 9, 28, 17, 0).getTime() });
    expect(countToday([today, yesterday], now)?.id).toBe('t');
  });
});

test('open balances split into what customers owe and what the store owes back', () => {
  const row = (documentId: string, balance: number): OpenBalanceRow => ({
    documentKind: 'repair.ticket',
    documentId,
    documentLabel: documentId,
    balance,
    since: 0,
  });
  const { owed, owedBack } = splitOpenBalances([row('a', 250_000), row('b', -100_000)]);
  expect(owed.map((r) => r.documentId)).toEqual(['a']);
  expect(owedBack.map((r) => r.documentId)).toEqual(['b']);
});

test("the drawer's moves include an owner's correction, signed as it changed the drawer", () => {
  const moves = drawerMoves([
    entry({ id: 'out', kind: 'cash_moved', subKind: 'expense', account: null, amount: 20_000 }),
    entry({ id: 'in', kind: 'cash_moved', subKind: 'float', account: null, amount: 50_000 }),
    entry({ id: 'fix', kind: 'cash_adjusted', account: null, amount: -5_000 }),
    entry({ id: 'paid', account: 'cash', amount: 100_000 }),
  ]);
  expect(moves.map((m) => [m.entry.id, m.label, m.delta])).toEqual([
    ['out', 'money.moveKind.expense', -20_000],
    ['in', 'money.moveKind.float', 50_000],
    ['fix', 'money.kas.adjusted', -5_000],
  ]);
});

describe('history', () => {
  beforeAll(() => {
    initI18n({ locale: 'id' });
    registerMoneyCatalog({ id: idCatalog, en: enCatalog });
  });

  const qris: PaymentAccountRow = {
    id: 'q',
    kind: 'qris',
    name: 'QRIS BCA',
    active: false,
    central: false,
    storeIds: [],
  };

  test('a payment names its servisan and method, even one switched off since', () => {
    const line = historyLine(entry({ account: 'account:q', amount: 150_000 }), [qris]);
    expect(line).toEqual({
      label: 'money.opType.paymentReceived',
      details: ['B7B-0001', 'QRIS BCA'],
      amount: formatMoney(150_000),
      voided: false,
    });
  });

  test('money that left the drawer or the bill reads negative', () => {
    const expense = historyLine(
      entry({
        kind: 'cash_moved',
        subKind: 'expense',
        account: null,
        amount: 25_000,
        reason: 'Bensin',
        documentLabel: null,
      }),
      [],
    );
    expect(expense.label).toBe('money.moveKind.expense');
    expect(expense.details).toEqual(['Bensin']);
    expect(expense.amount).toBe(`−${formatMoney(25_000)}`);
    const refund = historyLine(entry({ kind: 'refund_paid', amount: 20_000, reason: 'Batal' }), []);
    expect(refund.amount).toBe(`−${formatMoney(20_000)}`);
    expect(refund.details).toContain('Batal');
    const short = historyLine(entry({ kind: 'cash_adjusted', account: null, amount: -5_000 }), []);
    expect(short.label).toBe('money.kas.adjusted');
    expect(short.amount).toBe(`−${formatMoney(5_000)}`);
  });

  test('only a payment still standing can be cancelled', () => {
    expect(voidable(entry({}))).toBe(true);
    const voided = entry({ voidedAt: 5, voidReason: 'Salah metode' });
    expect(voidable(voided)).toBe(false);
    expect(historyLine(voided, []).voided).toBe(true);
    expect(voidable(entry({ kind: 'refund_paid' }))).toBe(false);
    expect(voidable(entry({ kind: 'charge_recorded' }))).toBe(false);
  });
});
