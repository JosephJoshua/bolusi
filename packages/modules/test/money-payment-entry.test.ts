// Taking a payment at the counter: a line whose method the store switched off while the form was
// open is not quietly booked to the drawer; it asks for a method again. Change that looks like a
// mistyped zero is asked about before it is saved.
import { describe, expect, test } from 'vitest';

import { CASH_ACCOUNT } from '../src/money/constants.js';
import {
  changeLooksWrong,
  changeToCheck,
  chosenMethod,
  LARGEST_NOTE,
  methodMissing,
  newPaymentLine,
  NO_METHOD,
  offeredAccount,
  paymentEntry,
} from '../src/money/payment-entry.js';
import type { PaymentAccountRow } from '../src/money/queries.js';

const QRIS: PaymentAccountRow = {
  id: '01920000-0000-7000-8000-0000000000a1',
  kind: 'qris',
  name: 'QRIS toko',
  active: true,
  central: false,
  storeIds: [],
};

const OTHER = '01920000-0000-7000-8000-0000000000a2';

describe('paymentEntry', () => {
  test('pays through the method picked while the store offers it', () => {
    const line = newPaymentLine('a', 100_000, `account:${QRIS.id}`);
    const entry = paymentEntry(100_000, [line], [QRIS]);
    expect(entry.complete).toBe(true);
    expect(entry.payments).toMatchObject([{ account: `account:${QRIS.id}`, amount: 100_000 }]);
  });

  test('a method switched off since it was picked needs picking again, never the drawer', () => {
    const line = newPaymentLine('a', 100_000, `account:${QRIS.id}`);
    const entry = paymentEntry(100_000, [line], []);
    expect(entry.complete).toBe(false);
    expect(entry.payments).toEqual([]);
    expect(entry.problems).toEqual({ a: 'method' });
  });
});

describe('the method is picked by the counter, never guessed', () => {
  test('where the store takes more than cash, a new line waits for its method', () => {
    const entry = paymentEntry(100_000, [newPaymentLine('a', 100_000)], [QRIS]);
    expect(entry.complete).toBe(false);
    expect(entry.payments).toEqual([]);
    expect(entry.problems).toEqual({ a: 'pick' });
    // The amount still counts toward what is left, so the rest adds up while it waits.
    expect(entry.remaining).toBe(0);
  });

  test('where cash is all the store takes, a new line is cash', () => {
    const entry = paymentEntry(100_000, [newPaymentLine('a', 100_000)], []);
    expect(entry.complete).toBe(true);
    expect(entry.payments).toMatchObject([{ account: CASH_ACCOUNT, amount: 100_000 }]);
  });

  test('a DP names its method once picked, and a switched-off one is picked again', () => {
    expect(methodMissing(NO_METHOD, [QRIS])).toBe(true);
    expect(methodMissing(NO_METHOD, [])).toBe(false);
    expect(methodMissing(CASH_ACCOUNT, [QRIS])).toBe(false);
    expect(methodMissing(`account:${QRIS.id}`, [{ ...QRIS, id: OTHER }])).toBe(true);
    expect(chosenMethod(NO_METHOD, '', []).account).toBe(CASH_ACCOUNT);
    expect(offeredAccount(`account:${QRIS.id}`, [QRIS])).toBe(`account:${QRIS.id}`);
  });
});

describe('change that looks wrong', () => {
  const cash = (amount: number, tendered: number | null) => ({
    account: 'cash',
    amount,
    reference: null,
    tendered,
  });

  test('a mistyped zero asks first; a note handed over for a small bill does not', () => {
    // 1.750.000 typed for 175.000: the counter would hand out 1.575.000.
    expect(changeToCheck([cash(175_000, 1_750_000)])).toEqual({
      change: 1_575_000,
      tendered: 1_750_000,
      amount: 175_000,
    });
    // Rp 100.000 for a Rp 30.000 bill, or 200.000 for 175.000: ordinary change.
    expect(changeToCheck([cash(30_000, 100_000)])).toBeNull();
    expect(changeToCheck([cash(175_000, 200_000)])).toBeNull();
    expect(changeToCheck([cash(175_000, 175_000)])).toBeNull();
    // A whole note more than needed is the line.
    expect(changeLooksWrong(175_000 + LARGEST_NOTE - 1, 175_000)).toBe(false);
    expect(changeLooksWrong(175_000 + LARGEST_NOTE, 175_000)).toBe(true);
  });

  test('only cash with what was handed over counts, line by line', () => {
    expect(changeToCheck([cash(175_000, null)])).toBeNull();
    expect(
      changeToCheck([{ account: 'account:edc', amount: 175_000, reference: 'A1' }]),
    ).toBeNull();
    // A sensible line beside a wrong one: only the wrong one is asked about.
    expect(changeToCheck([cash(50_000, 60_000), cash(125_000, 1_250_000)])).toEqual({
      change: 1_125_000,
      tendered: 1_250_000,
      amount: 125_000,
    });
    expect(changeToCheck([])).toBeNull();
  });
});
