// Handing a phone back through the real runtime: the servisan is charged, the customer pays the
// rest (in one or more methods), a cancelled servisan's DP less its fee goes back, and only an
// owner lets a phone go unpaid, which leaves a debt. The books stay balanced throughout.
import { sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { initI18n } from '@bolusi/i18n';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import enMoney from '../money/i18n/en.json' with { type: 'json' };
import idMoney from '../money/i18n/id.json' with { type: 'json' };
import { registerMoneyCatalog } from '../src/money/i18n.js';
import type { DocumentMoney } from '../src/money/queries.js';
import { refundMethods } from '../src/money/refund.js';
import {
  amountOwed,
  downPaymentAction,
  paidLabelKey,
  repairAbilities,
  ticketMoneyActions,
} from '../src/repair/flows.js';
import type { TicketDetailRow } from '../src/repair/queries.js';
import {
  accessoriesBack,
  openRepairHarness,
  intake,
  type RepairHarness,
} from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const TOTAL = 750_000;

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

async function openTicket(harness: RepairHarness, overrides: Record<string, unknown> = {}) {
  const { ticketId } = (await harness.run(
    'openTicket',
    intake(harness, overrides),
    harness.cashierId,
  )) as { ticketId: string };
  return ticketId;
}

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

function handover(harness: RepairHarness, ticketId: string, extra: Record<string, unknown> = {}) {
  return {
    ticketId,
    handoverPhoto: harness.photo(7),
    signature: harness.photo(8),
    checklist: accessoriesBack(),
    ...extra,
  };
}

async function ledger(harness: RepairHarness, ticketId: string) {
  return (
    await harness.moneyQuery(
      'documentMoney',
      { kind: 'repair.ticket', id: ticketId },
      harness.storeOwnerId,
    )
  ).rows[0] as {
    balance: number;
    charged: number;
    paid: number;
    entries: { kind: string; account: string | null; amount: number; tendered: number | null }[];
  };
}

async function location(harness: RepairHarness, ticketId: string) {
  return (
    (await harness.query('getTicket', { ticketId }, harness.cashierId)).rows[0] as {
      location: string;
    }
  ).location;
}

async function expectBalancedBooks(harness: RepairHarness): Promise<void> {
  const { rows } = await sql<{ net: number }>`
    SELECT SUM(debit) - SUM(credit) AS net FROM money_lines
  `.execute(harness.db);
  expect(Number(rows[0]!.net)).toBe(0);
}

describe('a repaired phone', () => {
  test('goes home once the rest of the bill is paid, split across methods', async () => {
    h = await openRepairHarness(7101);
    const ticketId = await repaired(h, { downPayment: 200_000 });
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS toko' },
      h.storeOwnerId,
    )) as { accountId: string };

    await expectRefused(
      h.run('returnDevice', handover(h, ticketId), h.cashierId),
      'VALIDATION_FAILED',
      'repair.refusal.notPaid',
    );
    await expectRefused(
      h.run(
        'returnDevice',
        handover(h, ticketId, { payments: [{ account: 'cash', amount: 500_000 }] }),
        h.cashierId,
      ),
      'VALIDATION_FAILED',
      'repair.refusal.notPaid',
    );
    // A refused handover records nothing: no charge, no payment.
    expect(await ledger(h, ticketId)).toMatchObject({ charged: 0, paid: 200_000 });

    await h.run(
      'returnDevice',
      handover(h, ticketId, {
        payments: [
          { account: 'cash', amount: 300_000, tendered: 350_000 },
          { account: `account:${accountId}`, amount: 250_000 },
        ],
      }),
      h.cashierId,
    );
    expect(await location(h, ticketId)).toBe('returned');
    const money = await ledger(h, ticketId);
    expect(money).toMatchObject({ balance: 0, charged: TOTAL, paid: TOTAL });
    expect(money.entries.map((e) => [e.kind, e.amount, e.tendered])).toEqual([
      ['payment_received', 200_000, null],
      ['charge_recorded', TOTAL, null],
      ['payment_received', 300_000, 350_000],
      ['payment_received', 250_000, null],
    ]);
    await expectBalancedBooks(h);
  });

  test('a price lowered below the DP gives the difference back, through the DP’s own account', async () => {
    h = await openRepairHarness(7102);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const account = `account:${accountId}`;
    const ticketId = await repaired(h, { downPayment: TOTAL, downPaymentAccount: account });
    await h.run(
      'changeQuote',
      {
        ticketId,
        kind: 'discount',
        description: 'Diskon',
        amount: -50_000,
        reason: 'Pelanggan tetap',
        customerAgreed: true,
      },
      h.storeOwnerId,
    );
    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    const money = await ledger(h, ticketId);
    expect(money.balance).toBe(0);
    expect(money.entries.at(-1)).toMatchObject({ kind: 'refund_paid', account, amount: 50_000 });
    await expectBalancedBooks(h);
  });
});

describe('a cancelled phone', () => {
  test('goes back with the DP less the fee returned in cash', async () => {
    h = await openRepairHarness(7201);
    const ticketId = await openTicket(h, { downPayment: 200_000 });
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    const money = await ledger(h, ticketId);
    expect(money).toMatchObject({ balance: 0, charged: 50_000, paid: 50_000 });
    expect(money.entries.map((e) => [e.kind, e.account, e.amount])).toEqual([
      ['payment_received', 'cash', 200_000],
      ['charge_recorded', 'cancel_fee_revenue', 50_000],
      ['refund_paid', 'cash', 150_000],
    ]);
    await expectBalancedBooks(h);
  });

  test('with a fee above the DP, the customer pays the rest', async () => {
    h = await openRepairHarness(7202);
    const ticketId = await openTicket(h, { downPayment: 20_000 });
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
    await expectRefused(
      h.run('returnDevice', handover(h, ticketId), h.cashierId),
      'VALIDATION_FAILED',
      'repair.refusal.notPaid',
    );
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: 'cash', amount: 30_000 }] }),
      h.cashierId,
    );
    expect(await ledger(h, ticketId)).toMatchObject({ balance: 0, charged: 50_000 });
  });

  test('with no fee and no DP, nothing touches the books', async () => {
    h = await openRepairHarness(7203);
    const ticketId = await openTicket(h);
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    expect((await ledger(h, ticketId)).entries).toEqual([]);
  });
});

describe('Bayar nanti', () => {
  test('only an owner lets a phone go unpaid; it is a debt until the customer pays', async () => {
    h = await openRepairHarness(7301);
    const ticketId = await repaired(h, { downPayment: 100_000 });
    const unpaid = { unpaidReason: 'Pelanggan langganan, bayar Jumat' };
    await expectRefused(
      h.run('returnDevice', handover(h, ticketId, unpaid), h.cashierId),
      'PERMISSION_DENIED',
      'repair.refusal.unpaidOwnerOnly',
    );
    await h.run('returnDevice', handover(h, ticketId, unpaid), h.ownerId);
    expect(await location(h, ticketId)).toBe('returned');

    const debts = await h.moneyQuery('openBalances', {}, h.storeOwnerId);
    expect(debts.rows).toMatchObject([{ documentId: ticketId, balance: TOTAL - 100_000 }]);

    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: 'cash', amount: TOTAL - 100_000 }],
      },
      h.cashierId,
    );
    expect((await h.moneyQuery('openBalances', {}, h.storeOwnerId)).rows).toEqual([]);
    await expectBalancedBooks(h);
  });

  test('a paid-up handover ignores a reason sent along', async () => {
    h = await openRepairHarness(7302);
    const ticketId = await repaired(h);
    await h.run(
      'returnDevice',
      handover(h, ticketId, {
        payments: [{ account: 'cash', amount: TOTAL }],
        unpaidReason: 'tidak perlu',
      }),
      h.cashierId,
    );
    expect(await location(h, ticketId)).toBe('returned');
  });
});

describe('a bill paid twice', () => {
  test('keeps both payments, and the owner sees what is owed back', async () => {
    h = await openRepairHarness(7501);
    const ticketId = await repaired(h);
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: 'cash', amount: TOTAL }] }),
      h.cashierId,
    );
    // A second counter, offline, took the same bill again: the cash is in its drawer.
    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: 'cash', amount: 100_000 }],
      },
      h.cashierId,
    );
    const open = await h.moneyQuery('openBalances', {}, h.storeOwnerId);
    expect(open.rows).toMatchObject([{ documentId: ticketId, balance: -100_000 }]);
    await expectBalancedBooks(h);
  });
});

describe('the DP once the phone went home', () => {
  test('is part of what was paid, and no longer something to correct', async () => {
    h = await openRepairHarness(7401);
    const ticketId = await repaired(h, { downPayment: 100_000 });
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: 'cash', amount: TOTAL - 100_000 }] }),
      h.cashierId,
    );
    const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0] as {
      location: 'returned';
      outcome: 'repaired';
      downPayment: number;
    };
    expect(ticket.downPayment).toBe(TOTAL);
    expect(paidLabelKey(ticket)).toBe('repair.price.paid');
    const identity = {
      tenantId: h.tenantId,
      storeId: h.storeId,
      deviceId: h.deviceId,
      userId: h.storeOwnerId,
    };
    const owner = repairAbilities((id) =>
      h!.runtime.commands.enforcementPoint.hasPermission(identity, id),
    );
    expect(downPaymentAction(ticket, owner)).toBeNull();
    // Correcting it would void the pickup payment too and turn a paid phone into a debt.
    await expectRefused(
      h.run('correctDownPayment', { ticketId, amount: 50_000, reason: 'x' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'repair.refusal.returned',
    );
  });

  test('a correction records the right amount through the method the owner picks', async () => {
    h = await openRepairHarness(7403);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const ticketId = await openTicket(h, { downPayment: 200_000 });
    await h.run(
      'correctDownPayment',
      { ticketId, amount: 150_000, reason: 'Ternyata lewat QRIS', account: `account:${accountId}` },
      h.storeOwnerId,
    );
    const money = await ledger(h, ticketId);
    expect(money.paid).toBe(150_000);
    expect(money.entries.at(-1)).toMatchObject({
      kind: 'payment_received',
      account: `account:${accountId}`,
      amount: 150_000,
    });
    await expectBalancedBooks(h);
  });

  test('a DP partly given back is not re-recorded by a correction', async () => {
    h = await openRepairHarness(7402);
    const ticketId = await openTicket(h, { downPayment: 200_000 });
    const document = { kind: 'repair.ticket', id: ticketId, label: 'x' };
    await h.money(
      'refund',
      { document, account: 'cash', amount: 50_000, reason: 'Kembali sebagian' },
      h.storeOwnerId,
    );
    await expectRefused(
      h.run('correctDownPayment', { ticketId, amount: 100_000, reason: 'x' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'repair.refusal.downPaymentRefunded',
    );
  });
});

/** The ledger's figures for a servisan, as the refund step reads them. */
async function documentMoney(harness: RepairHarness, ticketId: string): Promise<DocumentMoney> {
  return (await ledger(harness, ticketId)) as unknown as DocumentMoney;
}

describe('money after the phone went home', () => {
  beforeAll(() => {
    initI18n({ locale: 'id' });
    registerMoneyCatalog({ id: idMoney, en: enMoney });
  });
  async function ticket(harness: RepairHarness, ticketId: string) {
    return (await harness.query('getTicket', { ticketId }, harness.cashierId))
      .rows[0] as TicketDetailRow;
  }
  const document = (ticketId: string) => ({ kind: 'repair.ticket', id: ticketId, label: 'x' });
  const may = (harness: RepairHarness, userId: string) => (permission: string) =>
    harness.hasPermission(userId, permission);

  test('the counter gives back an overpayment, and the servisan reads paid in full again', async () => {
    h = await openRepairHarness(7601);
    const ticketId = await repaired(h);
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: 'cash', amount: TOTAL }] }),
      h.cashierId,
    );
    await h.money(
      'receivePayments',
      { document: document(ticketId), payments: [{ account: 'cash', amount: 100_000 }] },
      h.cashierId,
    );
    const overpaid = await ticket(h, ticketId);
    expect(amountOwed(overpaid) - (overpaid.downPayment ?? 0)).toBe(-100_000);
    expect(ticketMoneyActions(overpaid, may(h, h.cashierId))).toEqual({
      refund: true,
      reduce: false,
    });
    const methods = refundMethods(await documentMoney(h, ticketId), [], false);
    expect(methods).toMatchObject([{ account: 'cash', limit: 100_000 }]);

    // Beyond the overpayment is the owner's to give back.
    await expectRefused(
      h.money(
        'refund',
        { document: document(ticketId), account: 'cash', amount: 150_000, reason: 'lebih' },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
    );
    await h.money(
      'refund',
      { document: document(ticketId), account: 'cash', amount: 100_000, reason: 'Bayar dua kali' },
      h.cashierId,
    );
    const settled = await ticket(h, ticketId);
    expect(settled).toMatchObject({ downPayment: TOTAL, reduced: 0 });
    expect(ticketMoneyActions(settled, may(h, h.cashierId))).toEqual({
      refund: false,
      reduce: false,
    });
    expect((await h.moneyQuery('openBalances', {}, h.storeOwnerId)).rows).toEqual([]);
    await expectBalancedBooks(h);
  });

  test('an owner gives back part of a paid bill, which lowers the bill by as much', async () => {
    h = await openRepairHarness(7602);
    const ticketId = await repaired(h);
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: 'cash', amount: TOTAL }] }),
      h.cashierId,
    );
    const paid = await ticket(h, ticketId);
    expect(ticketMoneyActions(paid, may(h, h.ownerId))).toEqual({ refund: true, reduce: false });
    // Money goes back through the counter's command, which an owner without it cannot run.
    const without = (permission: string) =>
      permission !== 'money.receive' && h!.hasPermission(h!.ownerId, permission);
    expect(ticketMoneyActions(paid, without)).toEqual({ refund: false, reduce: false });
    expect(refundMethods(await documentMoney(h, ticketId), [], true)).toMatchObject([
      { account: 'cash', limit: TOTAL },
    ]);

    await h.money(
      'refund',
      { document: document(ticketId), account: 'cash', amount: 50_000, reason: 'Garansi kaca' },
      h.ownerId,
    );
    const after = await ticket(h, ticketId);
    expect(after).toMatchObject({ downPayment: TOTAL - 50_000, reduced: 50_000 });
    expect(amountOwed(after)).toBe(TOTAL - 50_000);
    expect((await h.moneyQuery('openBalances', {}, h.storeOwnerId)).rows).toEqual([]);
    await expectBalancedBooks(h);
  });

  test('an owner lowers a debt, and what is owed comes down on the servisan and in Kas', async () => {
    h = await openRepairHarness(7603);
    const ticketId = await repaired(h);
    await h.run('returnDevice', handover(h, ticketId, { unpaidReason: 'Bayar Jumat' }), h.ownerId);
    const owing = await ticket(h, ticketId);
    expect(ticketMoneyActions(owing, may(h, h.ownerId))).toEqual({ refund: false, reduce: true });
    expect(ticketMoneyActions(owing, may(h, h.cashierId))).toEqual({
      refund: false,
      reduce: false,
    });

    await expectRefused(
      h.money(
        'reduceCharge',
        { document: document(ticketId), amount: 100_000, reason: 'Diskon' },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
    );
    await h.money(
      'reduceCharge',
      { document: document(ticketId), amount: 100_000, reason: 'Pelanggan lama' },
      h.ownerId,
    );
    const lowered = await ticket(h, ticketId);
    expect(lowered.reduced).toBe(100_000);
    expect(amountOwed(lowered)).toBe(TOTAL - 100_000);
    expect((await h.moneyQuery('openBalances', {}, h.storeOwnerId)).rows).toMatchObject([
      { documentId: ticketId, balance: TOTAL - 100_000 },
    ]);
    await expectBalancedBooks(h);
  });
});
