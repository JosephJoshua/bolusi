// Staff pay through the real runtime (owner decisions 2026-11-28, product-scope.md "Staff pay"):
// commission on servisan worked out from repair's, money's and stock's records, kasbon as one
// balance per person, and one payout per person per month that the rules hold to the figures.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { commissionOn, payableMonth, payoutFigures, monthOf } from '../src/pay/index.js';
import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

const TOTAL = 750_000;
const LCD_COST = 300_000;

/** An LCD on the shelf bought at LCD_COST (or unpriced), ready to be taken for a servisan. */
async function stockedLcd(h: RepairHarness, unitCost: number | null = LCD_COST) {
  const { supplierId } = (await h.purchasing(
    'addSupplier',
    { name: 'Sumber Jaya', phone: null, note: null },
    h.storeOwnerId,
  )) as { supplierId: string };
  const { itemId } = (await h.runInventory(
    'addItem',
    { name: 'LCD Galaxy A14', code: null, fits: [] },
    h.storeOwnerId,
  )) as { itemId: string };
  const { orderId } = (await h.purchasing(
    'draftOrder',
    { supplierId, note: null, lines: [{ itemId, qty: 5 }], place: true },
    h.storeOwnerId,
  )) as { orderId: string };
  await h.purchasing(
    'receiveOrder',
    { orderId, lines: [{ itemId, qty: 5, ...(unitCost === null ? {} : { unitCost }) }] },
    h.storeOwnerId,
  );
  return { itemId, orderId };
}

/** A servisan the technician repaired with one LCD, not yet handed over. */
async function repairedWithLcd(h: RepairHarness, itemId: string, technicianId = h.technicianId) {
  const { ticketId, ticketNumber } = (await h.run('openTicket', intake(h), h.cashierId)) as {
    ticketId: string;
    ticketNumber: string;
  };
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, technicianId);
  await h.runInventory(
    'takePart',
    { itemId, qty: 1, use: { kind: 'repair_ticket', id: ticketId, label: ticketNumber } },
    technicianId,
  );
  await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, technicianId);
  return ticketId;
}

async function handedOver(h: RepairHarness, ticketId: string) {
  await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
}

async function statement(h: RepairHarness, userId: string) {
  return (await h.payQuery('payPerson', { userId, at: h.now() }, h.storeOwnerId)).rows[0] as {
    commission: { earned: number; owed: number; paid: number; pending: number; adjusted: number };
    servisan: { ticketId: string; commission: number | null; partCost: number | null }[];
    kasbon?: { balance: number; installment: number };
    payouts: { id: string; paid: number; commission: number; deduction: number }[];
    paidThisMonth: boolean;
  };
}

async function lastOp(h: RepairHarness, type: string): Promise<SignedOperation> {
  const ops = await h.ownOps();
  return ops.filter((op) => op.type === type).at(-1)!;
}

/** The same op with another payload and a fresh entity, as a modified app could push it. */
function forged(op: SignedOperation, payload: Record<string, unknown>, entityId: string) {
  return { ...op, entityId, payload: { ...(op.payload as object), ...payload } } as SignedOperation;
}

describe('commission figures', () => {
  test('a percentage of the profit, rounded down, never on a loss', () => {
    expect(commissionOn(450_000, 40)).toBe(180_000);
    expect(commissionOn(1_001, 33)).toBe(330);
    expect(commissionOn(-5_000, 40)).toBe(0);
  });

  test('a payout pays all that is owed; a take-back goes no lower than no pay', () => {
    expect(
      payoutFigures({ salary: 3_000_000, owed: 180_000, deduction: 300_000, kasbon: 1_000_000 }),
    ).toEqual({ salary: 3_000_000, commission: 180_000, deduction: 300_000, paid: 2_880_000 });
    // The installment never takes more than is left on the kasbon, or more than the pay.
    expect(
      payoutFigures({ salary: 200_000, owed: 0, deduction: 500_000, kasbon: 1_000_000 }),
    ).toEqual({ salary: 200_000, commission: 0, deduction: 200_000, paid: 0 });
    expect(payoutFigures({ salary: 0, owed: -50_000, deduction: 0, kasbon: 0 })).toEqual({
      salary: 0,
      commission: -0,
      deduction: 0,
      paid: 0,
    });
  });

  test('a payout is for this month or one of the two before, never ahead', () => {
    const at = Date.UTC(2026, 10, 15);
    expect(payableMonth('2026-11', at)).toBe(true);
    expect(payableMonth('2026-09', at)).toBe(true);
    expect(payableMonth('2026-08', at)).toBe(false);
    expect(payableMonth('2026-12', at)).toBe(false);
    // On the last evening of a month east of UTC, the next month has begun at the store.
    expect(payableMonth('2026-12', Date.UTC(2026, 10, 30, 20))).toBe(true);
  });
});

describe('commission on servisan', () => {
  test('nothing while the store has commission off', async () => {
    const h = await harness(9101);
    const { itemId } = await stockedLcd(h);
    await handedOver(h, await repairedWithLcd(h, itemId));
    expect((await statement(h, h.technicianId)).commission.owed).toBe(0);
  });

  test('earned once the phone has gone home paid in full, at the rate then', async () => {
    const h = await harness(9102);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    const { itemId } = await stockedLcd(h);
    const ticketId = await repairedWithLcd(h, itemId);
    expect((await statement(h, h.technicianId)).commission.owed).toBe(0);
    await handedOver(h, ticketId);
    const s = await statement(h, h.technicianId);
    expect(s.servisan).toMatchObject([{ ticketId, partCost: LCD_COST, commission: 180_000 }]);
    expect(s.commission.owed).toBe(commissionOn(TOTAL - LCD_COST, 40));
    // The other technician earned nothing from it.
    expect((await statement(h, h.technician2Id)).commission.owed).toBe(0);
  });

  test("a technician's own rate wins over the store's", async () => {
    const h = await harness(9103);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    await h.pay(
      'setTerms',
      { userId: h.technicianId, salary: 2_500_000, commissionPercent: 50 },
      h.storeOwnerId,
    );
    const { itemId } = await stockedLcd(h);
    await handedOver(h, await repairedWithLcd(h, itemId));
    expect((await statement(h, h.technicianId)).commission.owed).toBe(225_000);
  });

  test('Bayar nanti earns only once the debt is paid', async () => {
    const h = await harness(9104);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    const { itemId } = await stockedLcd(h);
    const ticketId = await repairedWithLcd(h, itemId);
    await h.run(
      'returnDevice',
      (await paidHandover(h, ticketId, { payments: [], unpaidReason: 'Bayar Jumat' })) as never,
      h.ownerId,
    );
    expect((await statement(h, h.technicianId)).commission.owed).toBe(0);
    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: 'cash', amount: TOTAL }],
      },
      h.cashierId,
    );
    expect((await statement(h, h.technicianId)).commission.owed).toBe(180_000);
  });

  test('a part with no price waits, then counts once the price is typed', async () => {
    const h = await harness(9105);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    const { itemId, orderId } = await stockedLcd(h, null);
    const ticketId = await repairedWithLcd(h, itemId);
    await handedOver(h, ticketId);
    let s = await statement(h, h.technicianId);
    expect(s.commission).toMatchObject({ owed: 0, pending: 1 });
    expect(s.servisan).toMatchObject([{ ticketId, commission: null, partCost: null }]);
    const receipt = (
      (await h.purchasingQuery('orderCosts', { orderId }, h.storeOwnerId)).rows as {
        movementId: string;
      }[]
    )[0]!;
    await h.runInventory(
      'priceStock',
      { movementId: receipt.movementId, unitCost: LCD_COST },
      h.storeOwnerId,
    );
    s = await statement(h, h.technicianId);
    expect(s.commission).toMatchObject({ owed: 180_000, pending: 0 });
  });

  test('a handover taken back stops counting; an owner may add or take off by hand', async () => {
    const h = await harness(9106);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    const { itemId } = await stockedLcd(h);
    const ticketId = await repairedWithLcd(h, itemId);
    await handedOver(h, ticketId);
    await h.run('undoHandover', { ticketId, reason: 'Salah HP' }, h.ownerId);
    expect((await statement(h, h.technicianId)).commission.owed).toBe(0);

    await h.pay(
      'adjustCommission',
      { userId: h.technicianId, amount: -50_000, reason: 'LCD kembali dalam garansi' },
      h.storeOwnerId,
    );
    expect((await statement(h, h.technicianId)).commission).toMatchObject({
      adjusted: -50_000,
      owed: -50_000,
    });
    // Commission by hand is the owners'.
    await expectRefused(
      h.pay(
        'adjustCommission',
        { userId: h.technicianId, amount: 50_000, reason: 'Bonus' },
        h.managerId,
      ),
      'PERMISSION_DENIED',
    );
  });

  test('a cancelled servisan earns nothing, even with a cancel fee', async () => {
    const h = await harness(9107);
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal', fee: 50_000 }, h.ownerId);
    await handedOver(h, ticketId);
    expect((await statement(h, h.technicianId)).servisan).toEqual([]);
  });
});

describe('kasbon', () => {
  test('one balance per person; repayments pay the oldest first', async () => {
    const h = await harness(9201);
    await h.pay(
      'giveAdvance',
      {
        userId: h.technicianId,
        amount: 1_000_000,
        account: 'cash',
        reason: 'Biaya sekolah anak',
        installment: 300_000,
      },
      h.managerId,
    );
    await h.pay(
      'giveAdvance',
      {
        userId: h.technicianId,
        amount: 200_000,
        account: 'cash',
        reason: 'Bensin',
        installment: 200_000,
      },
      h.storeOwnerId,
    );
    const kasbon = async () =>
      (await h.payQuery('kasbon', { userId: h.technicianId }, h.managerId)).rows[0] as {
        balance: number;
        installment: number;
      };
    expect(await kasbon()).toMatchObject({ balance: 1_200_000, installment: 500_000 });
    await h.pay(
      'repayAdvance',
      { userId: h.technicianId, amount: 1_000_000, account: 'cash', note: null },
      h.managerId,
    );
    // The first kasbon is paid off, so only the second's installment is left.
    expect(await kasbon()).toMatchObject({ balance: 200_000, installment: 200_000 });
    await expectRefused(
      h.pay(
        'repayAdvance',
        { userId: h.technicianId, amount: 300_000, account: 'cash', note: null },
        h.managerId,
      ),
      'VALIDATION_FAILED',
      'pay.refusal.aboveBalance',
    );
  });

  test('never to oneself, never an installment above the kasbon', async () => {
    const h = await harness(9202);
    const give = (userId: string, installment: number) =>
      h.pay(
        'giveAdvance',
        { userId, amount: 500_000, account: 'cash', reason: 'Kontrakan', installment },
        h.managerId,
      );
    await expectRefused(give(h.managerId, 100_000), 'PERMISSION_DENIED', 'pay.refusal.self');
    await expectRefused(
      give(h.technicianId, 600_000),
      'VALIDATION_FAILED',
      'pay.refusal.installmentAboveAmount',
    );
    // The cashier keeps no kasbon.
    await expectRefused(
      h.pay(
        'giveAdvance',
        { userId: h.technicianId, amount: 500_000, account: 'cash', reason: 'x', installment: 100 },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
    );
  });

  test('only an owner writes off what is left', async () => {
    const h = await harness(9203);
    await h.pay(
      'giveAdvance',
      {
        userId: h.technicianId,
        amount: 400_000,
        account: 'cash',
        reason: 'x',
        installment: 100_000,
      },
      h.managerId,
    );
    await expectRefused(
      h.pay('writeOffAdvance', { userId: h.technicianId, reason: 'Keluar' }, h.managerId),
      'PERMISSION_DENIED',
    );
    await h.pay('writeOffAdvance', { userId: h.technicianId, reason: 'Keluar' }, h.storeOwnerId);
    expect(
      (await h.payQuery('kasbon', { userId: h.technicianId }, h.storeOwnerId)).rows[0],
    ).toMatchObject({ balance: 0 });
  });
});

describe('monthly pay', () => {
  async function paidMonth(h: RepairHarness) {
    await h.pay('setStoreCommission', { commissionPercent: 40 }, h.storeOwnerId);
    await h.pay(
      'setTerms',
      { userId: h.technicianId, salary: 3_000_000, commissionPercent: null },
      h.storeOwnerId,
    );
    await h.pay(
      'giveAdvance',
      {
        userId: h.technicianId,
        amount: 1_000_000,
        account: 'cash',
        reason: 'x',
        installment: 300_000,
      },
      h.managerId,
    );
    const { itemId } = await stockedLcd(h);
    await handedOver(h, await repairedWithLcd(h, itemId));
    return itemId;
  }

  const month = (h: RepairHarness) => monthOf(h.now());

  test('salary + commission − installment, once a month', async () => {
    const h = await harness(9301);
    await paidMonth(h);
    const result = await h.pay(
      'payMonth',
      {
        userId: h.technicianId,
        month: month(h),
        salary: 3_000_000,
        deduction: 300_000,
        account: 'cash',
        note: null,
        at: h.now(),
      },
      h.storeOwnerId,
    );
    expect(result).toMatchObject({ commission: 180_000, deduction: 300_000, paid: 2_880_000 });
    const s = await statement(h, h.technicianId);
    expect(s.commission).toMatchObject({ earned: 180_000, paid: 180_000, owed: 0 });
    expect(s.kasbon).toMatchObject({ balance: 700_000 });
    expect(s.paidThisMonth).toBe(true);
    await expectRefused(
      h.pay(
        'payMonth',
        {
          userId: h.technicianId,
          month: month(h),
          salary: 0,
          deduction: 0,
          account: 'cash',
          at: h.now(),
        },
        h.storeOwnerId,
      ),
      'INVALID_TRANSITION',
      'pay.refusal.monthPaid',
    );
  });

  test('what is taken back after a payout comes off the next one', async () => {
    const h = await harness(9302);
    const itemId = await paidMonth(h);
    await h.pay(
      'payMonth',
      {
        userId: h.technicianId,
        month: month(h),
        salary: 3_000_000,
        deduction: 0,
        account: 'cash',
        at: h.now(),
      },
      h.storeOwnerId,
    );
    // A second phone, then a take-back of the first's commission by hand.
    await h.pay(
      'adjustCommission',
      { userId: h.technicianId, amount: -230_000, reason: 'Garansi' },
      h.storeOwnerId,
    );
    await handedOver(h, await repairedWithLcd(h, itemId));
    expect((await statement(h, h.technicianId)).commission.owed).toBe(180_000 - 230_000);
  });

  test('cancelling a payout owes its commission and its installment again', async () => {
    const h = await harness(9303);
    await paidMonth(h);
    await h.pay(
      'payMonth',
      {
        userId: h.technicianId,
        month: month(h),
        salary: 3_000_000,
        deduction: 300_000,
        account: 'cash',
        at: h.now(),
      },
      h.storeOwnerId,
    );
    const payout = (await statement(h, h.technicianId)).payouts[0]!;
    const repaymentId = (await lastOp(h, 'pay.advance_settled')).entityId;
    await h.pay(
      'voidPayout',
      { payoutId: payout.id, repaymentId, reason: 'Salah orang' },
      h.storeOwnerId,
    );
    const s = await statement(h, h.technicianId);
    expect(s.commission.owed).toBe(180_000);
    expect(s.kasbon).toMatchObject({ balance: 1_000_000 });
    expect(s.paidThisMonth).toBe(false);
  });

  test('the server holds a payout to its own figures', async () => {
    const h = await harness(9304);
    await paidMonth(h);
    await h.pay(
      'payMonth',
      {
        userId: h.technicianId,
        month: month(h),
        salary: 3_000_000,
        deduction: 300_000,
        account: 'cash',
        at: h.now(),
      },
      h.storeOwnerId,
    );
    const op = await lastOp(h, 'pay.salary_paid');
    await h.pay(
      'voidPayout',
      {
        payoutId: op.entityId,
        repaymentId: (op.payload as { repaymentId: string }).repaymentId,
        reason: 'x',
      },
      h.storeOwnerId,
    );
    const fresh = '0191e000-0000-7000-8000-0000000c0de1';
    const refusal = async (payload: Record<string, unknown>) =>
      h.checkRule(forged(op, payload, fresh)).then(
        () => null,
        (e: unknown) => refusalKeyOf(e),
      );
    // As recorded, it would pass again (the first one is cancelled).
    expect(await refusal({ repaymentId: null, deduction: 0, paid: 3_180_000 })).toBeNull();
    expect(
      await refusal({ commission: 180_001, deduction: 0, repaymentId: null, paid: 3_180_001 }),
    ).toBe('pay.refusal.commissionAboveOwed');
    expect(
      await refusal({ salary: 3_000_001, deduction: 0, repaymentId: null, paid: 3_180_001 }),
    ).toBe('pay.refusal.salaryAboveTerms');
    expect(await refusal({ deduction: 0, repaymentId: null, paid: 3_500_000 })).toBe(
      'pay.refusal.paidNotTotal',
    );
    expect(await refusal({ deduction: 1_000_001, paid: 2_179_999 })).toBe(
      'pay.refusal.aboveBalance',
    );
    expect(
      await refusal({ userId: h.storeOwnerId, deduction: 0, repaymentId: null, paid: 3_180_000 }),
    ).toBe('pay.refusal.self');
    expect(
      await refusal({ month: '2030-01', deduction: 0, repaymentId: null, paid: 3_180_000 }),
    ).toBe('pay.refusal.monthOutOfRange');
  });

  test('an installment off pay records only with its payout, as it says', async () => {
    const h = await harness(9305);
    await paidMonth(h);
    await h.pay(
      'payMonth',
      {
        userId: h.technicianId,
        month: month(h),
        salary: 3_000_000,
        deduction: 300_000,
        account: 'cash',
        at: h.now(),
      },
      h.storeOwnerId,
    );
    const op = await lastOp(h, 'pay.advance_settled');
    const fresh = '0191e000-0000-7000-8000-0000000c0de2';
    await expect(h.checkRule(forged(op, { amount: 900_000 }, fresh))).rejects.toSatisfy(
      (e: unknown) => refusalKeyOf(e) === 'pay.refusal.repaymentNotAsPayout',
    );
  });
});
