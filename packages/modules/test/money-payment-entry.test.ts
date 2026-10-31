// Taking a payment at the counter: a line whose method the store switched off while the form was
// open is not quietly booked to the drawer; it asks for a method again.
import { describe, expect, test } from 'vitest';

import { CASH_ACCOUNT } from '../src/money/constants.js';
import {
  chosenMethod,
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
