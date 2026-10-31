// The Kas arithmetic the phone and the PC share: money in by method, counts left to settle, today's
// count and what customers owe or are owed.
import { formatMoney, initI18n } from '@bolusi/i18n';
import { beforeAll, describe, expect, test } from 'vitest';

import enCatalog from '../money/i18n/en.json' with { type: 'json' };
import idCatalog from '../money/i18n/id.json' with { type: 'json' };
import { registerMoneyCatalog } from '../src/money/i18n.js';
import { methodStores, methodSummary } from '../src/money/methods.js';
import { historyEmptyKey, shiftDay } from '../src/money/day-records.js';
import { MONEY_PERMISSION } from '../src/money/constants.js';

import {
  cashMoveCheck,
  countToday,
  dayStart,
  moneyIn,
  differenceToSettle,
  drawerMoves,
  historyLine,
  inHistory,
  settleState,
  splitOpenBalances,
  voidAbilities,
  voidKind,
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
    createdByName: null,
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
  test('payments that still count by method, the drawer first, and what went back on its own', () => {
    expect(
      moneyIn([
        entry({ account: 'account:qris', amount: 300_000 }),
        entry({ account: 'cash', amount: 100_000 }),
        entry({ account: 'cash', amount: 50_000 }),
        entry({ kind: 'refund_paid', account: 'cash', amount: 20_000 }),
        entry({ account: 'account:edc', amount: 900_000, voidedAt: 5 }),
        entry({ kind: 'charge_recorded', account: null, amount: 750_000 }),
        entry({ kind: 'cash_moved', subKind: 'expense', account: null, amount: 10_000 }),
      ]),
    ).toEqual({
      methods: [
        { account: 'cash', amount: 150_000 },
        { account: 'account:qris', amount: 300_000 },
      ],
      refunded: 20_000,
      total: 430_000,
    });
  });

  // Round 2 QA, F14: a refund today of an earlier day's QRIS payment read "QRIS -Rp 150.000".
  test('a refund of an earlier payment is not a negative money in for its method', () => {
    expect(
      moneyIn([
        entry({ account: 'cash', amount: 50_000 }),
        entry({ kind: 'refund_paid', account: 'account:qris', amount: 150_000 }),
      ]),
    ).toEqual({
      methods: [{ account: 'cash', amount: 50_000 }],
      refunded: 150_000,
      total: -100_000,
    });
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

  test('a difference being settled follows the drawer as it syncs, and closes once overtaken', () => {
    const opened = count({ id: 'c', difference: -10_000, countedAt: 1 });
    // A payment from before the count synced while the owner read: the difference moved.
    const moved = { ...opened, expected: opened.expected - 4_000, difference: -6_000 };
    expect(settleState([moved], opened)).toEqual({ live: moved, open: true });
    // Not read yet: the count as it was opened.
    expect(settleState(null, opened)).toEqual({ live: opened, open: true });
    const newer = count({ id: 'n', difference: -1_000, countedAt: 2 });
    expect(settleState([newer, moved], opened).open).toBe(false);
    expect(settleState([{ ...moved, settled: -6_000 }], opened).open).toBe(false);
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

test('nobody takes more cash out of the drawer than the book says is in it', () => {
  const move = (kind: 'withdrawal' | 'float', amount: number, drawer: number | null) =>
    cashMoveCheck({ kind, account: null, amount, reason: 'Setor', accounts: [], drawer });
  expect(move('withdrawal', 700_000, 700_000).missing).toBeNull();
  expect(move('withdrawal', 900_000, 700_000)).toMatchObject({
    missing: 'money.move.aboveDrawer',
    missingValues: { amount: formatMoney(700_000) },
  });
  // A drawer the book already has short reads as empty, never as a minus amount.
  expect(move('withdrawal', 1, -5_000).missingValues).toEqual({ amount: formatMoney(0) });
  // Change money put in is never limited, and nothing is judged before the drawer has loaded.
  expect(move('float', 900_000, 0).missing).toBeNull();
  expect(move('withdrawal', 900_000, null).missing).toBeNull();
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
    // One minus sign everywhere: the one formatMoney writes (round 2 QA, F14).
    expect(expense.amount).toBe('\u2212Rp 25.000');
    expect(expense.amount).toBe(formatMoney(-25_000));
    const refund = historyLine(entry({ kind: 'refund_paid', amount: 20_000, reason: 'Batal' }), []);
    expect(refund.amount).toBe('\u2212Rp 20.000');
    expect(refund.details).toContain('Batal');
    // A handover refund is saved as a code, and older ones in fixed English: both read localized.
    for (const reason of ['handover_refund', 'Returned at handover']) {
      const handover = historyLine(entry({ kind: 'refund_paid', amount: 1, reason }), []);
      expect(handover.details).toContain('Sisa DP saat HP diambil');
      expect(handover.details).not.toContain(reason);
    }
    const short = historyLine(entry({ kind: 'cash_adjusted', account: null, amount: -5_000 }), []);
    expect(short.label).toBe('money.kas.adjusted');
    expect(short.amount).toBe('\u2212Rp 5.000');
  });

  test('each record says who recorded it, last', () => {
    const line = historyLine(
      entry({ account: 'account:q', createdByName: 'Dewi' }),
      [qris],
      'Yakobus',
    );
    expect(line.details).toEqual(['Yakobus', 'B7B-0001', 'QRIS BCA', 'Dewi']);
  });

  test('the bill recorded at handover is not money that moved, so Riwayat leaves it out', () => {
    expect(inHistory(entry({ kind: 'charge_recorded' }))).toBe(false);
    for (const kind of [
      'charge_reduced',
      'payment_received',
      'refund_paid',
      'cash_moved',
      'cash_counted',
      'cash_adjusted',
    ] as const) {
      expect(inHistory(entry({ kind }))).toBe(true);
    }
  });

  test('an empty day says today may still get some, a past day that it had none', () => {
    const today = dayStart(Date.now());
    expect(historyEmptyKey(today, today)).toBe('money.history.none');
    expect(historyEmptyKey(shiftDay(today, -1), today)).toBe('money.history.noneDay');
  });

  test('a cancelled payment keeps its customer, servisan and method, and says why', () => {
    const line = historyLine(
      entry({ account: 'account:q', amount: 150_000, voidedAt: 5, voidReason: 'Salah metode' }),
      [qris],
      'Yulianus Wenda',
    );
    expect(line.details).toEqual([
      'Yulianus Wenda',
      'B7B-0001',
      'QRIS BCA',
      'Dibatalkan: Salah metode',
    ]);
  });

  test('the day before and after start at local midnight', () => {
    const day = new Date(2026, 9, 28).getTime();
    expect(shiftDay(day, -1)).toBe(new Date(2026, 9, 27).getTime());
    expect(shiftDay(day, 1)).toBe(new Date(2026, 9, 29).getTime());
  });

  test('a payment or a cash move still standing can be cancelled, each by whoever may', () => {
    const owner = { payments: true, cashMoves: true };
    expect(voidable(entry({}), owner)).toBe(true);
    const voided = entry({ voidedAt: 5, voidReason: 'Salah metode' });
    expect(voidable(voided, owner)).toBe(false);
    expect(historyLine(voided, []).voided).toBe(true);
    expect(voidable(entry({ kind: 'refund_paid' }), owner)).toBe(false);
    expect(voidable(entry({ kind: 'charge_recorded' }), owner)).toBe(false);
    expect(voidable(entry({ kind: 'cash_counted' }), owner)).toBe(false);
    const move = entry({ kind: 'cash_moved', subKind: 'float' });
    expect(voidable(move, owner)).toBe(true);
    // A manager may cancel a payment within limits, but settling the drawer is the owner's.
    expect(voidable(move, { payments: true, cashMoves: false })).toBe(false);
    expect(voidKind(move).command).toBe('voidCashMove');
  });

  test('a void limit of 0 cancels no payment, the same as not holding it', () => {
    const holds = (id: string) => id === MONEY_PERMISSION.voidPayment;
    expect(voidAbilities(holds, () => 100_000)).toEqual({ payments: true, cashMoves: false });
    expect(voidAbilities(holds, () => 0).payments).toBe(false);
    expect(voidAbilities(holds).payments).toBe(true);
    expect(voidKind(entry({})).command).toBe('voidPayment');
  });
});

describe('payment methods', () => {
  beforeAll(() => {
    initI18n({ locale: 'id' });
    registerMoneyCatalog({ id: idCatalog, en: enCatalog });
  });

  const stores = [
    { id: 's1', name: 'Bolusi Jayapura' },
    { id: 's2', name: 'Bolusi Sorong' },
  ];
  const method = (overrides: Partial<PaymentAccountRow>): PaymentAccountRow => ({
    id: 'm',
    kind: 'qris',
    name: 'QRIS Pusat',
    active: true,
    central: true,
    storeIds: [],
    ...overrides,
  });

  test('a head-office method names the stores it is for, or says every store', () => {
    expect(methodStores(method({}), stores)).toBe('Semua toko');
    expect(methodStores(method({ storeIds: ['s2', 's1'] }), stores)).toBe(
      'Bolusi Sorong, Bolusi Jayapura',
    );
    // A store this device has not heard of yet: the count, not a list missing one.
    expect(methodStores(method({ storeIds: ['s1', 'gone'] }), stores)).toBe('2 toko');
  });

  test("the list's line: kind, where it is used, and whether it is switched off", () => {
    expect(methodSummary(method({ storeIds: ['s2'], active: false }), stores)).toBe(
      'QRIS · Bolusi Sorong · Tidak dipakai',
    );
    expect(methodSummary(method({ central: false, kind: 'edc' }), stores)).toBe('EDC');
  });
});
