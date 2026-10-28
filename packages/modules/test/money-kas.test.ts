// The Kas arithmetic the phone and the PC share: money in by method, counts left to settle, today's
// count and what customers owe or are owed.
import { describe, expect, test } from 'vitest';

import {
  countToday,
  dayStart,
  moneyInByMethod,
  splitOpenBalances,
  unsettledCounts,
} from '../src/money/kas.js';
import type { CashCountRow, MoneyEntryRow, OpenBalanceRow } from '../src/money/queries.js';

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
  test('only a difference no owner has settled is left', () => {
    const left = unsettledCounts([
      count({ id: 'exact' }),
      count({ id: 'short', difference: -5_000 }),
      count({ id: 'settled', difference: 2_000, settled: 2_000 }),
    ]);
    expect(left.map((row) => row.id)).toEqual(['short']);
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
