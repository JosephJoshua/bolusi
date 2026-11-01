// When "Ubah biaya" on a cancelled servisan asks an owner instead (cancel-fee-ask.ts), and what it
// asks for, as the change's own rules would judge it: before a charge the fee, counted from the
// store's fee with the discounts against the cancel limit; after it a cut off the bill, counted
// with earlier cuts against the refund limit.
import { describe, expect, test } from 'vitest';

import { cancelFeeRequest, type CancelFeeTicket } from '../src/repair/cancel-fee-ask.js';

const ticket = (discount = 0): CancelFeeTicket => ({
  id: 't-1',
  ticketNumber: 'T-1',
  customerName: 'Budi',
  workStarted: false,
  claimOfTicketId: null,
  quoteLines:
    discount === 0
      ? []
      : [
          {
            id: 'l-1',
            kind: 'discount',
            description: 'Diskon',
            amount: -discount,
            status: 'applied',
            reason: null,
            customerAgreed: true,
            createdBy: 'u',
            createdAt: 0,
            decidedBy: null,
            decidedAt: null,
            decisionNote: null,
          },
        ],
});
const limits = { cancel: 50_000, refund: 30_000 };
const uncharged = { charged: 0, reduced: 0 };

describe('before anything is charged: the fee, against the cancel limit', () => {
  test('within the limit from the store fee it is theirs; one rupiah past it is asked', () => {
    expect(cancelFeeRequest(ticket(), uncharged, 100_000, 50_000, limits, 100_000)).toBeNull();
    expect(cancelFeeRequest(ticket(), uncharged, 100_000, 49_999, limits, 100_000)).toEqual({
      kind: 'repair.cancelFee',
      input: { ticketId: 't-1', fee: 49_999 },
    });
  });

  test('a second step down counts from the store fee, with the discounts', () => {
    // Already at 60.000 of a 100.000 fee: 55.000 is 45.000 below, plus a 10.000 discount.
    expect(cancelFeeRequest(ticket(10_000), uncharged, 60_000, 55_000, limits, 100_000)).toEqual({
      kind: 'repair.cancelFee',
      input: { ticketId: 't-1', fee: 55_000 },
    });
    expect(cancelFeeRequest(ticket(), uncharged, 60_000, 55_000, limits, 100_000)).toBeNull();
  });
});

describe('once charged: a cut off the bill, against the refund limit', () => {
  test('the cut is asked as a lower bill, counting the cuts already made', () => {
    const charged = { charged: 70_000, reduced: 0 };
    expect(cancelFeeRequest(ticket(), charged, 70_000, 40_000, limits, 0)).toBeNull();
    expect(cancelFeeRequest(ticket(), charged, 70_000, 39_999, limits, 0)).toEqual({
      kind: 'money.reduceCharge',
      input: { document: { kind: 'repair.ticket', id: 't-1', label: 'T-1' }, amount: 30_001 },
    });
    // 20.000 cut before: another 20.000 is 40.000 in all.
    const cut = { charged: 70_000, reduced: 20_000 };
    expect(cancelFeeRequest(ticket(), cut, 50_000, 30_000, limits, 0)?.kind).toBe(
      'money.reduceCharge',
    );
  });
});

test('raising, or an unlimited role, never asks', () => {
  expect(cancelFeeRequest(ticket(), uncharged, 50_000, 80_000, limits, 100_000)).toBeNull();
  const none = { cancel: null, refund: null };
  expect(cancelFeeRequest(ticket(), uncharged, 100_000, 0, none, 100_000)).toBeNull();
  expect(
    cancelFeeRequest(ticket(), { charged: 70_000, reduced: 0 }, 70_000, 0, none, 0),
  ).toBeNull();
});
