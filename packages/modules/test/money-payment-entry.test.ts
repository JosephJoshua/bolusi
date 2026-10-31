// Taking a payment at the counter: a line whose method the store switched off while the form was
// open is not quietly booked to the drawer; it asks for a method again.
import { describe, expect, test } from 'vitest';

import { newPaymentLine, paymentEntry } from '../src/money/payment-entry.js';
import type { PaymentAccountRow } from '../src/money/queries.js';

const QRIS: PaymentAccountRow = {
  id: '01920000-0000-7000-8000-0000000000a1',
  kind: 'qris',
  name: 'QRIS toko',
  active: true,
  central: false,
  storeIds: [],
};

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
