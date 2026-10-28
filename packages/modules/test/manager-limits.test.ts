// A manager's limits through the real runtime (product-scope.md, "Managers, limits, approvals and
// roles"): the owners' money decisions, each as far as the store's limit for the role goes, per
// servisan. Every refusal has its control: the same step within the limit, or by an owner.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import {
  accessoriesBack,
  intake,
  MANAGER_LIMITS,
  openRepairHarness,
  type RepairHarness,
} from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function expectOverLimit(p: Promise<unknown>, module: 'repair' | 'money'): Promise<void> {
  const err = await p.then(
    () => new Error('expected the limit to refuse it, but the call resolved'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe('PERMISSION_DENIED');
  expect(refusalKeyOf(err)).toBe(`${module}.refusal.overLimit`);
}

/** The manager's limit of `kind` as a judging side applies it, noting each amount judged. */
const managerLimit =
  (kind: keyof typeof MANAGER_LIMITS, judged: number[] = []) =>
  (_user: string, _permission: string, amount: number) => {
    judged.push(amount);
    return Promise.resolve(amount <= MANAGER_LIMITS[kind]);
  };

const discount = (amount: number) => ({
  kind: 'discount',
  description: 'Diskon langganan',
  amount: -amount,
});

async function openTicket(harness: RepairHarness, overrides: Record<string, unknown> = {}) {
  const { ticketId } = (await harness.run(
    'openTicket',
    intake(harness, overrides),
    harness.cashierId,
  )) as { ticketId: string };
  return ticketId;
}

function changePrice(harness: RepairHarness, ticketId: string, amount: number, userId: string) {
  return harness.run(
    'changeQuote',
    { ticketId, ...discount(amount), reason: 'Pelanggan langganan', customerAgreed: true },
    userId,
  );
}

async function repaired(harness: RepairHarness, overrides: Record<string, unknown>) {
  const ticketId = await openTicket(harness, overrides);
  await harness.run(
    'startWork',
    { ticketId, beforePhotos: [harness.photo(20)] },
    harness.technicianId,
  );
  await harness.run(
    'markRepaired',
    { ticketId, afterPhotos: [harness.photo(21)] },
    harness.technicianId,
  );
  return ticketId;
}
const unpaid = (harness: RepairHarness, ticketId: string, cash: number) => ({
  ticketId,
  handoverPhoto: harness.photo(7),
  signature: harness.photo(8),
  checklist: accessoriesBack(),
  payments: cash > 0 ? [{ account: 'cash', amount: cash }] : [],
  unpaidReason: 'Bayar Jumat',
});

describe('discounts', () => {
  test('a manager discounts up to the limit at intake; an owner beyond it', async () => {
    h = await openRepairHarness(9101);
    const lines = (amount: number) => ({
      quoteLines: [{ kind: 'part', description: 'LCD', amount: 650_000 }, discount(amount)],
    });
    await expectOverLimit(
      h.run('openTicket', intake(h, lines(MANAGER_LIMITS.priceDrop + 1)), h.managerId),
      'repair',
    );
    await h.run('openTicket', intake(h, lines(MANAGER_LIMITS.priceDrop)), h.managerId);
    await h.run('openTicket', intake(h, lines(MANAGER_LIMITS.priceDrop + 1)), h.storeOwnerId);
  });

  test('the limit is per servisan: discounts already on it count', async () => {
    h = await openRepairHarness(9102);
    const ticketId = await openTicket(h);
    await changePrice(h, ticketId, 30_000, h.managerId);
    await expectOverLimit(changePrice(h, ticketId, 30_000, h.managerId), 'repair');
    await changePrice(h, ticketId, 20_000, h.managerId);
    // Another servisan starts from nothing.
    await changePrice(h, await openTicket(h), 50_000, h.managerId);
  });
});

describe('cancel fees', () => {
  test('a manager cancels at the store fee, or lower by no more than the limit', async () => {
    h = await openRepairHarness(9201);
    await h.run('setCancelFees', { beforeWork: 100_000, afterWork: 150_000 }, h.storeOwnerId);
    const first = await openTicket(h);
    await expectOverLimit(
      h.run('cancelTicket', { ticketId: first, reason: 'Batal', fee: 49_999 }, h.managerId),
      'repair',
    );
    await h.run('cancelTicket', { ticketId: first, reason: 'Batal', fee: 50_000 }, h.managerId);
    // The store's fee, and an owner's waiver, need no limit.
    await h.run('cancelTicket', { ticketId: await openTicket(h), reason: 'Batal' }, h.managerId);
    await h.run(
      'cancelTicket',
      { ticketId: await openTicket(h), reason: 'Batal', fee: 0 },
      h.storeOwnerId,
    );
  });

  test('an older phone cancelling with no fee (v1) charges nothing, so the whole fee counts', async () => {
    h = await openRepairHarness(9202);
    await h.run('setCancelFees', { beforeWork: 100_000, afterWork: 150_000 }, h.storeOwnerId);
    const ticketId = await openTicket(h);
    const opened = (await h.ownOps()).find(
      (op) => op.type === 'repair.ticket_opened' && op.entityId === ticketId,
    )!;
    const cancelV1 = {
      ...opened,
      type: 'repair.ticket_cancelled',
      schemaVersion: 1,
      payload: { reason: 'Batal' },
    };
    const judged: number[] = [];
    await expectOverLimit(
      h.checkRule({ ...cancelV1, userId: h.managerId }, managerLimit('priceDrop', judged)),
      'repair',
    );
    expect(judged).toEqual([100_000]);
    // An owner has no limit.
    await h.checkRule({ ...cancelV1, userId: h.storeOwnerId }, () => Promise.resolve(true));
  });
});

describe('Bayar nanti', () => {
  test('a manager lets a phone go for a debt within the limit only', async () => {
    h = await openRepairHarness(9301);
    // The bill is 750.000: paying 650.000 leaves 100.000, the limit; 649.999 leaves one more.
    const ticketId = await repaired(h, {});
    await expectOverLimit(
      h.run('returnDevice', unpaid(h, ticketId, 649_999), h.managerId),
      'repair',
    );
    await h.run('returnDevice', unpaid(h, ticketId, 650_000), h.managerId);
    const other = await repaired(h, {});
    await h.run('returnDevice', unpaid(h, other, 0), h.ownerId);
  });
});

describe('refunds and voids', () => {
  test('a void takes the payments voided on the servisan together against the refund limit', async () => {
    h = await openRepairHarness(9401);
    const ticketId = await openTicket(h);
    const document = { kind: 'repair.ticket', id: ticketId, label: 'x' };
    const pay = async (amount: number) =>
      (
        (await h!.money(
          'receivePayments',
          { document, payments: [{ account: 'cash', amount }] },
          h!.cashierId,
        )) as { entryIds: string[] }
      ).entryIds[0]!;
    const big = await pay(MANAGER_LIMITS.refund + 1);
    await expectOverLimit(
      h.money('voidPayment', { entryId: big, reason: 'Salah ketik' }, h.managerId),
      'money',
    );
    await h.money('voidPayment', { entryId: big, reason: 'Salah ketik' }, h.storeOwnerId);

    const small = await pay(20_000);
    // The owner's void above counts too: this servisan is already past the manager's limit.
    await expectOverLimit(
      h.money('voidPayment', { entryId: small, reason: 'Dobel' }, h.managerId),
      'money',
    );
    const elsewhere = await openTicket(h);
    const doc2 = { kind: 'repair.ticket', id: elsewhere, label: 'y' };
    const { entryIds } = (await h.money(
      'receivePayments',
      { document: doc2, payments: [{ account: 'cash', amount: 20_000 }] },
      h.cashierId,
    )) as { entryIds: string[] };
    await h.money('voidPayment', { entryId: entryIds[0]!, reason: 'Dobel' }, h.managerId);
  });

  test('a manager refunds beyond what the customer overpaid only within the limit', async () => {
    h = await openRepairHarness(9402);
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    const document = { kind: 'repair.ticket', id: ticketId, label: 'x' };
    const refund = (amount: number, userId: string) =>
      h!.money('refund', { document, account: 'cash', amount, reason: 'Batal servis' }, userId);
    await expectOverLimit(refund(MANAGER_LIMITS.refund + 1, h.managerId), 'money');
    await refund(MANAGER_LIMITS.refund, h.managerId);
    // Earlier refunds on the servisan count.
    await expectOverLimit(refund(1, h.managerId), 'money');
    await refund(10_000, h.storeOwnerId);
  });

  test('a DP correction counts only what the DP went down by', async () => {
    h = await openRepairHarness(9403);
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    const correct = (amount: number, userId: string) =>
      h!.run('correctDownPayment', { ticketId, amount, reason: 'Salah ketik' }, userId);
    await correct(80_000, h.managerId);
    await correct(70_000, h.managerId);
    // 100.000 to 69.000 is past the manager's Rp 30.000, however it is split.
    await expectOverLimit(correct(69_000, h.managerId), 'money');
    await correct(0, h.storeOwnerId);

    const other = await openTicket(h, { downPayment: 100_000 });
    await expectOverLimit(
      h.run('correctDownPayment', { ticketId: other, amount: 60_000, reason: 'x' }, h.managerId),
      'money',
    );
  });

  test('a payment recorded in place of a DP lowers what its void counts, until the bill', async () => {
    h = await openRepairHarness(9404);
    const ticketId = await repaired(h, { downPayment: 100_000 });
    const other = await openTicket(h, { downPayment: 100_000 });
    await h.run(
      'correctDownPayment',
      { ticketId, amount: 90_000, reason: 'Salah ketik' },
      h.managerId,
    );
    const ops = await h.ownOps();
    const replacement = ops.filter((op) => op.type === 'money.payment_received').at(-1)!;
    const voided = ops.filter((op) => op.type === 'money.payment_voided').at(-1)!;
    let judged: number | null = null;
    const judge = (_user: string, _permission: string, amount: number) => {
      judged = amount;
      return Promise.resolve(true);
    };
    const voidOfReplacement = () =>
      h!.checkRule({ ...voided, entityId: replacement.entityId }, judge);
    const forgedReplacement = (replaces: string) =>
      h!.checkRule({
        ...replacement,
        entityId: '0191e000-0000-7000-8000-00000000f0f0',
        payload: { ...replacement.payload, replaces },
      });
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => refusalKeyOf(e),
      );

    // Voiding the Rp 90.000 too takes the whole Rp 100.000 DP off, no more.
    await voidOfReplacement();
    expect(judged).toBe(100_000);
    // Another servisan's payment cannot be replaced from this one.
    const otherDp = (
      await h.db
        .selectFrom('moneyEntries')
        .select('id')
        .where('documentId', '=', other)
        .where('kind', '=', 'payment_received')
        .executeTakeFirstOrThrow()
    ).id!;
    expect(await refusal(forgedReplacement(otherDp))).toBe('money.refusal.replacementNotFound');

    // Once billed, nothing is recorded in place of a payment and every void counts in full.
    await h.run(
      'returnDevice',
      { ...unpaid(h, ticketId, 660_000), unpaidReason: undefined },
      h.cashierId,
    );
    expect(await refusal(forgedReplacement(replacement.entityId))).toBe(
      'money.refusal.replacementNotFound',
    );
    await voidOfReplacement();
    expect(judged).toBe(190_000);
  });
});
