// Approval requests through the real runtime (product-scope.md, "Managers, limits, approvals and
// roles"): someone asks for a decision they may not make, an owner (or someone whose limit covers
// it) approves, and the decision is recorded as the approver's in the same step. Every refusal has
// its control: the same step by someone allowed, or before the servisan moved on.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { formatMoney, initI18n } from '@bolusi/i18n';

import { describeRepairApproval } from '../src/repair/approval-copy.js';
import { cancelFeeRequest } from '../src/repair/cancel-fee-ask.js';
import { tn } from '../src/repair/i18n.js';
import {
  accessoriesBack,
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

let h: RepairHarness | null = null;
beforeAll(() => {
  initI18n({ locale: 'id' });
});
afterEach(async () => {
  await h?.close();
  h = null;
});

async function refused(p: Promise<unknown>, key: string, code?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${key}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(refusalKeyOf(err)).toBe(key);
  if (code !== undefined) expect((err as DomainError).code).toBe(code);
}

async function openTicket(
  harness: RepairHarness,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { ticketId } = (await harness.run(
    'openTicket',
    intake(harness, overrides),
    harness.cashierId,
  )) as { ticketId: string };
  return ticketId;
}

/** A servisan of 750.000 repaired and waiting at the counter. */
async function repaired(harness: RepairHarness, overrides: Record<string, unknown> = {}) {
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

/** The counter hands the phone over with `cash` paid and the rest left as a debt. */
const unpaidHandover = (harness: RepairHarness, ticketId: string, cash: number) => ({
  ticketId,
  handoverPhoto: harness.photo(7),
  signature: harness.photo(8),
  checklist: accessoriesBack(),
  payments: cash > 0 ? [{ account: 'cash', amount: cash }] : [],
  unpaidReason: 'Bayar Jumat',
});

const discountLine = (ticketId: string, amount: number) => ({
  ticketId,
  kind: 'discount',
  description: 'Diskon langganan',
  amount: -amount,
  reason: 'Pelanggan langganan',
  customerAgreed: true,
});

async function ask(
  harness: RepairHarness,
  kind: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<string> {
  const { requestId } = (await harness.approvals(
    'requestApproval',
    { kind, input, reason: 'Pelanggan minta' },
    userId,
  )) as { requestId: string };
  return requestId;
}

async function ticket(harness: RepairHarness, ticketId: string) {
  return (await harness.query('getTicket', { ticketId }, harness.ownerId)).rows[0];
}

async function request(harness: RepairHarness, requestId: string, userId: string) {
  return (await harness.approvalsQuery('approvalRequest', { requestId }, userId)).rows[0];
}

describe('a discount asked for by the counter', () => {
  test('the owner approves it, and the discount is the owner’s', async () => {
    h = await openRepairHarness(9501);
    const ticketId = await openTicket(h);
    // Control: the counter cannot give it themselves.
    await refused(
      h.run('changeQuote', discountLine(ticketId, 20_000), h.cashierId),
      'repair.refusal.discountOwnerOnly',
    );
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);

    const mine = await request(h, requestId, h.cashierId);
    expect(mine).toMatchObject({ status: 'waiting', amount: 20_000, mine: true, canDecide: false });
    const inbox = (await h.approvalsQuery('approvalRequests', {}, h.storeOwnerId)).rows;
    expect(inbox.map((row) => [row.id, row.canDecide])).toEqual([[requestId, true]]);
    // Someone who can neither ask nor decide it sees nothing waiting.
    expect((await h.approvalsQuery('approvalRequests', {}, h.technicianId)).rows).toEqual([]);

    await h.approvals('approveRequest', { requestId, note: 'Oke' }, h.storeOwnerId);
    expect(await request(h, requestId, h.cashierId)).toMatchObject({
      status: 'approved',
      decidedBy: h.storeOwnerId,
      note: 'Oke',
    });
    const line = (await ticket(h, ticketId)).quoteLines.find(
      (row: { kind: string }) => row.kind === 'discount',
    );
    expect(line).toMatchObject({ amount: -20_000, createdBy: h.storeOwnerId });
  });

  test('never by the asker, and only by someone holding the decision', async () => {
    h = await openRepairHarness(9502);
    const ticketId = await openTicket(h);
    const own = await ask(h, 'repair.discount', discountLine(ticketId, 10_000), h.storeOwnerId);
    await refused(
      h.approvals('approveRequest', { requestId: own }, h.storeOwnerId),
      'approvals.refusal.ownRequest',
      'PERMISSION_DENIED',
    );
    await h.approvals('withdrawRequest', { requestId: own }, h.storeOwnerId);

    const asked = await ask(h, 'repair.discount', discountLine(ticketId, 10_000), h.cashierId);
    // Approving runs the price change, which a technician cannot make.
    await expect(
      h.approvals('approveRequest', { requestId: asked }, h.technicianId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await refused(
      h.approvals('rejectRequest', { requestId: asked }, h.technicianId),
      'approvals.refusal.cannotDecide',
    );
    // A technician cannot change prices, so cannot ask for a discount either.
    await refused(
      ask(h, 'repair.discount', discountLine(ticketId, 5_000), h.technicianId),
      'approvals.refusal.cannotAsk',
    );
    await h.approvals('approveRequest', { requestId: asked }, h.ownerId);
  });

  test('a manager approves within their limit only, and the request keeps waiting', async () => {
    h = await openRepairHarness(9503);
    const ticketId = await openTicket(h);
    const big = await ask(h, 'repair.discount', discountLine(ticketId, 50_001), h.cashierId);
    await refused(
      h.approvals('approveRequest', { requestId: big }, h.managerId),
      'approvals.refusal.overLimit',
    );
    expect((await request(h, big, h.cashierId)).status).toBe('waiting');
    await h.approvals('approveRequest', { requestId: big }, h.ownerId);

    const other = await openTicket(h);
    const small = await ask(h, 'repair.discount', discountLine(other, 50_000), h.cashierId);
    await h.approvals('approveRequest', { requestId: small }, h.managerId);
  });

  test('one waiting request per decision, and it closes when the servisan changes', async () => {
    h = await openRepairHarness(9504);
    const ticketId = await openTicket(h);
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
    await refused(
      ask(h, 'repair.discount', discountLine(ticketId, 15_000), h.cashierId),
      'approvals.refusal.alreadyAsked',
    );
    // The price moves on before anyone answers.
    await h.run(
      'changeQuote',
      { ...discountLine(ticketId, 0), kind: 'part', amount: 50_000, description: 'Baterai' },
      h.cashierId,
    );
    expect((await request(h, requestId, h.storeOwnerId)).status).toBe('closed');
    expect((await h.approvalsQuery('approvalRequests', {}, h.storeOwnerId)).rows).toEqual([]);
    await expect(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // Asking again against the new price is fine.
    await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
  });

  test('only the asker withdraws, and a withdrawn request is never approved', async () => {
    h = await openRepairHarness(9505);
    const ticketId = await openTicket(h);
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
    await refused(
      h.approvals('withdrawRequest', { requestId }, h.storeOwnerId),
      'approvals.refusal.notYours',
    );
    await h.approvals('withdrawRequest', { requestId }, h.cashierId);
    await expect(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  test('a price that does not drop needs no approval', async () => {
    h = await openRepairHarness(9506);
    const ticketId = await openTicket(h);
    await refused(
      ask(
        h,
        'repair.discount',
        { ...discountLine(ticketId, 0), kind: 'part', amount: 10_000 },
        h.cashierId,
      ),
      'approvals.refusal.notNeeded',
    );
  });
});

describe('a cancel asked for by the counter', () => {
  test('the owner approves it at the asked fee', async () => {
    h = await openRepairHarness(9511);
    await h.run('setCancelFees', { beforeWork: 100_000, afterWork: 150_000 }, h.storeOwnerId);
    const ticketId = await openTicket(h);
    const input = { ticketId, reason: 'Pelanggan batal', fee: 30_000 };
    await expect(h.run('cancelTicket', input, h.cashierId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const requestId = await ask(h, 'repair.cancel', input, h.cashierId);
    expect((await request(h, requestId, h.ownerId)).amount).toBe(70_000);
    // 70.000 below the fee is beyond the manager's 50.000.
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.overLimit',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', cancelFee: 30_000 });
  });

  test('a smaller fee counts with the discounts on the servisan, as the rule counts it', async () => {
    h = await openRepairHarness(9513);
    await h.run('setCancelFees', { beforeWork: 100_000, afterWork: 150_000 }, h.storeOwnerId);
    const ticketId = await openTicket(h);
    await h.run('changeQuote', discountLine(ticketId, 30_000), h.ownerId);
    const input = { ticketId, reason: 'Pelanggan batal', fee: 70_000 };
    const requestId = await ask(h, 'repair.cancel', input, h.cashierId);
    // 30.000 below the fee alone is within the manager's 50.000; with the 30.000 discount it is not.
    expect(await request(h, requestId, h.managerId)).toMatchObject({
      amount: 30_000,
      counted: 60_000,
    });
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.overLimit',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', cancelFee: 70_000 });
  });

  test('a rejection records the note and changes nothing', async () => {
    h = await openRepairHarness(9512);
    const ticketId = await openTicket(h);
    const requestId = await ask(h, 'repair.cancel', { ticketId, reason: 'Batal' }, h.cashierId);
    await h.approvals('rejectRequest', { requestId, note: 'Telepon dulu' }, h.storeOwnerId);
    expect(await request(h, requestId, h.cashierId)).toMatchObject({
      status: 'rejected',
      note: 'Telepon dulu',
    });
    expect((await ticket(h, ticketId)).outcome).toBe('received');
    // The asker reads their own answered requests back; nobody else's come with them.
    const mine = await h.approvalsQuery('approvalRequests', { mine: true }, h.cashierId);
    expect(mine.rows).toMatchObject([{ id: requestId, status: 'rejected', mine: true }]);
    const owners = await h.approvalsQuery('approvalRequests', { mine: true }, h.storeOwnerId);
    expect(owners.rows).toEqual([]);
  });
});

describe('a cancelled servisan’s fee lowered beyond a manager’s limit (Ubah biaya)', () => {
  /** Cancelled at the store's Rp 100.000 before work, still in the store. */
  async function cancelled(harness: RepairHarness) {
    await harness.run(
      'setCancelFees',
      { beforeWork: 100_000, afterWork: 150_000 },
      harness.storeOwnerId,
    );
    const ticketId = await openTicket(harness);
    await harness.run('cancelTicket', { ticketId, reason: 'Batal' }, harness.storeOwnerId);
    return ticketId;
  }

  test('before pickup the manager asks, and the owner’s yes sets the fee as the owner’s', async () => {
    h = await openRepairHarness(9561);
    const ticketId = await cancelled(h);
    const input = { ticketId, fee: 40_000, reason: 'Pelanggan lama' };
    // Control: Rp 60.000 below the store's fee is past the manager's Rp 50.000.
    await refused(h.run('changeCancelFee', input, h.managerId), 'repair.refusal.overLimit');
    const requestId = await ask(h, 'repair.cancelFee', input, h.managerId);
    expect(await request(h, requestId, h.storeOwnerId)).toMatchObject({
      status: 'waiting',
      amount: 60_000,
      counted: 60_000,
      canDecide: true,
    });
    // Never by the asker; the counter neither changes the fee nor asks for it.
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.ownRequest',
    );
    await refused(
      h.approvals('requestApproval', { kind: 'repair.cancelFee', input, reason: 'x' }, h.cashierId),
      'approvals.refusal.cannotAsk',
      'PERMISSION_DENIED',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', cancelFee: 40_000 });
    const changed = (await h.ownOps()).filter((op) => op.type === 'repair.cancel_fee_changed');
    expect(changed.map((op) => op.userId)).toEqual([h.storeOwnerId]);
  });

  test('closes once the fee changes another way or the phone is charged at pickup', async () => {
    h = await openRepairHarness(9562);
    const ticketId = await cancelled(h);
    const first = await ask(
      h,
      'repair.cancelFee',
      { ticketId, fee: 40_000, reason: 'Kenal' },
      h.managerId,
    );
    await h.run('changeCancelFee', { ticketId, fee: 90_000, reason: 'Diskon' }, h.storeOwnerId);
    expect((await request(h, first, h.storeOwnerId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId: first }, h.storeOwnerId),
      'approvals.refusal.changed',
    );

    const second = await ask(
      h,
      'repair.cancelFee',
      { ticketId, fee: 30_000, reason: 'Kenal' },
      h.managerId,
    );
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    expect((await request(h, second, h.storeOwnerId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId: second }, h.storeOwnerId),
      'approvals.refusal.changed',
    );
    expect((await ticket(h, ticketId)).cancelFee).toBe(90_000);
  });

  test('once charged, the owner reads the fee asked and their yes cuts the bill to it', async () => {
    h = await openRepairHarness(9563);
    const ticketId = await openTicket(h);
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 70_000 }, h.storeOwnerId);
    await h.run(
      'returnDevice',
      (await paidHandover(h, ticketId, {
        payments: [{ account: 'cash', amount: 50_000 }],
        unpaidReason: 'Sisa minggu depan',
      })) as never,
      h.ownerId,
    );
    const row = await ticket(h, ticketId);
    // Rp 70.000 to Rp 20.000 cuts Rp 50.000 off the bill: past the manager's Rp 30.000.
    await expect(
      h.run('changeCancelFee', { ticketId, fee: 20_000, reason: 'Kenal' }, h.managerId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const asked = cancelFeeRequest(
      row,
      { charged: 70_000, reduced: 0 },
      70_000,
      20_000,
      { cancel: 50_000, refund: 30_000 },
      0,
    );
    expect(asked?.kind).toBe('repair.cancelFeeCharged');
    const requestId = await ask(h, asked!.kind, { ...asked!.input, reason: 'Kenal' }, h.managerId);
    // The fee typed is what is asked; the cut is what the refund limit counts.
    const waiting = await request(h, requestId, h.storeOwnerId);
    expect(waiting).toMatchObject({ status: 'waiting', amount: 50_000, canDecide: true });
    expect(waiting.input).toMatchObject({ fee: 20_000 });
    expect(describeRepairApproval(waiting)).toMatchObject({
      title: tn('repair.cancel.fee'),
      amount: formatMoney(20_000),
      notes: [tn('repair.approval.cancelBillDown', { amount: formatMoney(50_000) })],
    });
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    const after = await ticket(h, ticketId);
    expect((after.cancelFee ?? 0) - after.reduced).toBe(20_000);
    // Paid 50.000 against a bill of 20.000: 30.000 is owed back.
    const money = (
      await h.moneyQuery('documentMoney', { kind: 'repair.ticket', id: ticketId }, h.ownerId)
    ).rows[0] as { balance: number };
    expect(money.balance).toBe(-30_000);
  });
});

describe('the server judges a request on its own', () => {
  test('a request whose amount is not what the servisan says is refused', async () => {
    h = await openRepairHarness(9521);
    const ticketId = await openTicket(h);
    await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
    const [op] = (await h.ownOps()).filter((o) => o.type === 'approvals.request_made');
    const forged = { ...op!, payload: { ...op!.payload, amount: 1 } };
    await expect(h.checkRule(forged as never)).rejects.toSatisfy(
      (e: unknown) => refusalKeyOf(e) === 'approvals.refusal.changed',
    );
  });

  test('a second approval made elsewhere cannot add the discount again', async () => {
    h = await openRepairHarness(9522);
    const ticketId = await openTicket(h);
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    // The decision's line is named after the request, so another approver's copy is the same line.
    const [line] = (await h.ownOps()).filter((o) => o.type === 'repair.quote_changed');
    expect(line!.payload['lineId']).toBe(requestId);
    await expect(h.checkRule({ ...line!, opId: 'other-device-op' } as never)).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === 'INVALID_TRANSITION',
    );
  });

  test('an approver’s limit counts the discounts already on the servisan', async () => {
    h = await openRepairHarness(9523);
    const ticketId = await openTicket(h);
    await h.run('changeQuote', discountLine(ticketId, 30_000), h.ownerId);
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 25_000), h.cashierId);
    // The manager's 50.000 covers 25.000 alone, not with the 30.000 already standing.
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.overLimit',
    );
    await h.approvals('approveRequest', { requestId }, h.ownerId);
  });

  test('a request stays closed once the servisan moved, even if its total comes back', async () => {
    h = await openRepairHarness(9524);
    const ticketId = await openTicket(h);
    const requestId = await ask(h, 'repair.discount', discountLine(ticketId, 20_000), h.cashierId);
    const { lineId } = (await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Lem', amount: 10_000, reason: 'Perlu' },
      h.technicianId,
    )) as { lineId: string };
    await h.run('declineProposal', { ticketId, lineId }, h.cashierId);
    expect((await request(h, requestId, h.cashierId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
      'approvals.refusal.changed',
    );
  });
});

describe('Bayar nanti asked for by the counter', () => {
  test('approved, it lets the counter leave a debt up to its amount, with the customer there', async () => {
    h = await openRepairHarness(9531);
    const ticketId = await repaired(h);
    // Control: the counter cannot let the phone go unpaid on their own.
    await refused(
      h.run('returnDevice', unpaidHandover(h, ticketId, 0), h.cashierId),
      'repair.refusal.unpaidOwnerOnly',
    );
    const requestId = await ask(h, 'repair.payLater', { ticketId }, h.cashierId);
    expect((await request(h, requestId, h.cashierId)).amount).toBe(750_000);
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    // Approving changes nothing yet: the counter uses it at handover.
    expect((await ticket(h, ticketId)).location).toBe('in_store');
    // Another counter person may use it, and pay part of it now.
    await h.run('returnDevice', unpaidHandover(h, ticketId, 50_000), h.cashierId);
    expect((await ticket(h, ticketId)).location).toBe('returned');
  });

  test('an approval covers only the debt it was asked for', async () => {
    h = await openRepairHarness(9532);
    const ticketId = await repaired(h, { downPayment: 100_000 });
    const requestId = await ask(h, 'repair.payLater', { ticketId }, h.cashierId);
    expect((await request(h, requestId, h.cashierId)).amount).toBe(650_000);
    // A manager's 100.000 does not cover 650.000; the store owner's does.
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.overLimit',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    // The price goes up after the approval: the permit no longer covers what is left.
    await h.run(
      'changeQuote',
      {
        ticketId,
        kind: 'labour',
        description: 'Ganti konektor',
        amount: 50_000,
        reason: 'Perlu',
        customerAgreed: true,
      },
      h.storeOwnerId,
    );
    await refused(
      h.run('returnDevice', unpaidHandover(h, ticketId, 0), h.cashierId),
      'repair.refusal.unpaidOwnerOnly',
    );
    await h.run('returnDevice', unpaidHandover(h, ticketId, 50_000), h.cashierId);
  });

  test('only for a phone ready to collect', async () => {
    h = await openRepairHarness(9533);
    const ticketId = await openTicket(h);
    await expect(ask(h, 'repair.payLater', { ticketId }, h.cashierId)).rejects.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
    });
    // A technician hands nothing over, so asks nothing about it.
    const ready = await repaired(h);
    await refused(
      ask(h, 'repair.payLater', { ticketId: ready }, h.technicianId),
      'approvals.refusal.cannotAsk',
    );
  });
});

describe('a down payment fix asked for by the counter', () => {
  const fix = (ticketId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    ticketId,
    amount,
    reason: 'Salah ketik',
    ...extra,
  });

  test('approved, the DP is fixed as the approver’s, and only the decrease counts', async () => {
    h = await openRepairHarness(9541);
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    // Control: the counter cannot fix it themselves.
    await expect(
      h.run('correctDownPayment', fix(ticketId, 80_000), h.cashierId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const requestId = await ask(h, 'repair.downPayment', fix(ticketId, 80_000), h.cashierId);
    expect((await request(h, requestId, h.cashierId)).amount).toBe(20_000);
    // Within the manager's 30.000 refund limit.
    await h.approvals('approveRequest', { requestId }, h.managerId);
    expect((await ticket(h, ticketId)).downPayment).toBe(80_000);
  });

  test('through another method it counts in full, against the refund limit', async () => {
    h = await openRepairHarness(9542);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS Toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    const requestId = await ask(
      h,
      'repair.downPayment',
      fix(ticketId, 90_000, {
        account: `account:${accountId}`,
        reference: 'QR-1',
      }),
      h.cashierId,
    );
    expect((await request(h, requestId, h.cashierId)).amount).toBe(100_000);
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.overLimit',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
  });

  test('closes once the payments it would void change', async () => {
    h = await openRepairHarness(9543);
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    const requestId = await ask(h, 'repair.downPayment', fix(ticketId, 80_000), h.cashierId);
    await h.run('correctDownPayment', fix(ticketId, 90_000), h.storeOwnerId);
    expect((await request(h, requestId, h.cashierId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
      'approvals.refusal.changed',
    );
  });
});

describe('cancelling a payment, asked from Kas', () => {
  async function paidTwice(harness: RepairHarness) {
    const ticketId = await openTicket(harness);
    const document = { kind: 'repair.ticket', id: ticketId, label: 'T-1' };
    const pay = async (amount: number) => {
      await harness.money(
        'receivePayments',
        { document, payments: [{ account: 'cash', amount }] },
        harness.cashierId,
      );
      return (
        await harness.db
          .selectFrom('moneyEntries')
          .select('id')
          .where('kind', '=', 'payment_received')
          .where('amount', '=', amount)
          .executeTakeFirstOrThrow()
      ).id!;
    };
    return { document, first: await pay(15_000), second: await pay(20_000) };
  }

  const voidInput = (entryId: string, document: { kind: string; id: string }) => ({
    entryId,
    reason: 'Tercatat dua kali',
    document: { kind: document.kind, id: document.id },
  });

  test('the counter asks, and an owner’s yes cancels it as the owner’s', async () => {
    h = await openRepairHarness(9541);
    const { document, second } = await paidTwice(h);
    await expect(
      h.money('voidPayment', { entryId: second, reason: 'Salah' }, h.cashierId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const requestId = await ask(h, 'money.voidPayment', voidInput(second, document), h.cashierId);
    expect(await request(h, requestId, h.storeOwnerId)).toMatchObject({
      targetId: document.id,
      amount: 20_000,
    });
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    const entry = await h.db
      .selectFrom('moneyEntries')
      .select(['voidedBy', 'voidReason'])
      .where('id', '=', second)
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ voidedBy: h.storeOwnerId, voidReason: 'Tercatat dua kali' });
  });

  test('a manager’s limit counts what was already taken off, as the void’s rule does', async () => {
    h = await openRepairHarness(9542);
    const { document, first, second } = await paidTwice(h);
    await h.money('voidPayment', { entryId: first, reason: 'Salah metode' }, h.storeOwnerId);
    // Rp 20.000 alone fits the manager's Rp 30.000; with the Rp 15.000 cancelled before, it does not.
    const counted = await h.moneyQuery('voidCount', { entryId: second }, h.managerId);
    expect(counted.rows).toEqual([{ counted: 35_000 }]);
    await expect(
      h.money('voidPayment', { entryId: second, reason: 'Salah' }, h.managerId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const requestId = await ask(h, 'money.voidPayment', voidInput(second, document), h.managerId);
    expect(await request(h, requestId, h.ownerId)).toMatchObject({
      amount: 20_000,
      counted: 35_000,
    });
    await h.approvals('approveRequest', { requestId }, h.ownerId);
  });

  test('closes once the payment is cancelled another way', async () => {
    h = await openRepairHarness(9543);
    const { document, second } = await paidTwice(h);
    const requestId = await ask(h, 'money.voidPayment', voidInput(second, document), h.cashierId);
    await h.money('voidPayment', { entryId: second, reason: 'Salah' }, h.storeOwnerId);
    expect((await request(h, requestId, h.storeOwnerId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
      'approvals.refusal.changed',
    );
  });
});

describe('a refund or a lower bill beyond a manager’s limit', () => {
  /** A Rp 750.000 servisan handed back paid in full in cash. */
  async function pickedUp(harness: RepairHarness) {
    const ticketId = await repaired(harness);
    await harness.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: harness.photo(7),
        signature: harness.photo(8),
        checklist: accessoriesBack(),
        payments: [{ account: 'cash', amount: 750_000 }],
      },
      harness.cashierId,
    );
    return { kind: 'repair.ticket', id: ticketId, label: 'T-1' };
  }

  const refundInput = (document: { kind: string; id: string; label: string }, amount: number) => ({
    document,
    account: 'cash',
    amount,
    reason: 'Garansi tidak jalan',
    reference: null,
  });
  const refundAsk = (document: { kind: string; id: string; label: string }, amount: number) => ({
    ...refundInput(document, amount),
    methodLabel: 'Tunai',
  });

  async function money(harness: RepairHarness, id: string) {
    return (
      await harness.moneyQuery('documentMoney', { kind: 'repair.ticket', id }, harness.ownerId)
    ).rows[0] as { balance: number; reduced: number; paid: number };
  }

  test('the manager asks, and the owner’s yes gives it back as the owner’s', async () => {
    h = await openRepairHarness(9551);
    const document = await pickedUp(h);
    // Control: Rp 40.000 is past the manager's Rp 30.000.
    await expect(
      h.money('refund', refundInput(document, 40_000), h.managerId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const requestId = await ask(h, 'money.refund', refundAsk(document, 40_000), h.managerId);
    expect(await request(h, requestId, h.storeOwnerId)).toMatchObject({
      targetId: document.id,
      amount: 40_000,
      counted: 40_000,
      canDecide: true,
    });
    // The counter never decides it, nor asks for one.
    await refused(
      h.approvals('approveRequest', { requestId }, h.managerId),
      'approvals.refusal.ownRequest',
    );
    await refused(
      h.approvals(
        'requestApproval',
        { kind: 'money.refund', input: refundAsk(document, 40_000), reason: 'x' },
        h.cashierId,
      ),
      'approvals.refusal.cannotAsk',
      'PERMISSION_DENIED',
    );
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    const refund = await h.db
      .selectFrom('moneyEntries')
      .select(['amount', 'createdBy', 'account'])
      .where('documentId', '=', document.id)
      .where('kind', '=', 'refund_paid')
      .executeTakeFirstOrThrow();
    expect(refund).toMatchObject({ amount: 40_000, createdBy: h.storeOwnerId, account: 'cash' });
    // The bill came down with it, so the customer owes nothing.
    expect(await money(h, document.id)).toMatchObject({ balance: 0, reduced: 40_000 });
  });

  test('a lower bill asked by the manager lands as the owner’s', async () => {
    h = await openRepairHarness(9552);
    const ticketId = await repaired(h);
    await h.run('returnDevice', unpaidHandover(h, ticketId, 0), h.ownerId);
    const document = { kind: 'repair.ticket', id: ticketId, label: 'T-1' };
    const reduce = { document, amount: 60_000, reason: 'Pelanggan lama' };
    await expect(h.money('reduceCharge', reduce, h.managerId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const requestId = await ask(h, 'money.reduceCharge', reduce, h.managerId);
    expect(await request(h, requestId, h.storeOwnerId)).toMatchObject({
      amount: 60_000,
      counted: 60_000,
    });
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
    expect(await money(h, ticketId)).toMatchObject({ balance: 690_000, reduced: 60_000 });
  });

  test('names a method only by the name the store gave it', async () => {
    h = await openRepairHarness(9554);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BCA Toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const ticketId = await repaired(h);
    await h.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: h.photo(7),
        signature: h.photo(8),
        checklist: accessoriesBack(),
        payments: [{ account: `account:${accountId}`, amount: 750_000, reference: 'TRF-1' }],
      },
      h.cashierId,
    );
    const document = { kind: 'repair.ticket', id: ticketId, label: 'T-1' };
    const through = (methodLabel: string) => ({
      ...refundAsk(document, 40_000),
      account: `account:${accountId}`,
      methodLabel,
    });
    // A request that names the money going back some other way is never sent.
    await expect(ask(h, 'money.refund', through('Tunai'), h.managerId)).rejects.toMatchObject({
      code: 'ENTITY_NOT_FOUND',
    });
    const requestId = await ask(h, 'money.refund', through('BCA Toko'), h.managerId);
    await h.approvals('approveRequest', { requestId }, h.storeOwnerId);
  });

  test('closes once money moves on the servisan, and an owner gives it back another way', async () => {
    h = await openRepairHarness(9553);
    const document = await pickedUp(h);
    const requestId = await ask(h, 'money.refund', refundAsk(document, 40_000), h.managerId);
    await h.money('refund', refundInput(document, 10_000), h.storeOwnerId);
    expect((await request(h, requestId, h.storeOwnerId)).status).toBe('closed');
    await refused(
      h.approvals('approveRequest', { requestId }, h.storeOwnerId),
      'approvals.refusal.changed',
    );
  });
});
