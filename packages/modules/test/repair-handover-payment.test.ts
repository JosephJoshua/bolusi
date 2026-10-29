// Handing a phone back through the real runtime: the servisan is charged, the customer pays the
// rest (in one or more methods), a cancelled servisan's DP less its fee goes back, and only an
// owner lets a phone go unpaid, which leaves a debt. The books stay balanced throughout.
import { sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { formatMoney, initI18n } from '@bolusi/i18n';
import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';

import {
  downPaymentAction,
  paidLabelKey,
  repairAbilities,
  ticketBalance,
  ticketBill,
} from '../src/repair/flows.js';
import { payLaterOffer } from '../src/repair/handover-payment.js';
import { handoverSlip } from '../src/repair/print.js';
import type { TicketDetailRow } from '../src/repair/queries.js';
import {
  accessoriesBack,
  openRepairHarness,
  intake,
  type RepairHarness,
} from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

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
    entries: {
      kind: string;
      account: string | null;
      amount: number;
      tendered: number | null;
      reason: string | null;
      voidedAt: number | null;
    }[];
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

describe('an overpaid handover', () => {
  test('gives the overpayment back through the transfer that made it, not from the drawer', async () => {
    h = await openRepairHarness(7103);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const transfer = `account:${accountId}`;
    const ticketId = await repaired(h, { downPayment: 200_000 });
    // The whole bill again by a transfer nobody can see yet: the cash DP must stay in the drawer.
    await h.run(
      'returnDevice',
      handover(h, ticketId, { payments: [{ account: transfer, amount: TOTAL }] }),
      h.cashierId,
    );
    const money = await ledger(h, ticketId);
    expect(money.balance).toBe(0);
    expect(money.entries.at(-1)).toMatchObject({
      kind: 'refund_paid',
      account: transfer,
      amount: 200_000,
    });
    await expectBalancedBooks(h);
  });

  test('a DP split across methods comes back from what was left of each', async () => {
    h = await openRepairHarness(7104);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const qris = `account:${accountId}`;
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: qris, amount: 100_000 }],
      },
      h.cashierId,
    );
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    const money = await ledger(h, ticketId);
    expect(money.balance).toBe(0);
    // The cash DP came first and paid the fee: 50.000 cash and the whole QRIS go back.
    expect(money.entries.filter((e) => e.kind === 'refund_paid')).toMatchObject([
      { account: 'cash', amount: 50_000 },
      { account: qris, amount: 100_000 },
    ]);
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
    // Saved as a code, not in the words of this device's language: each reader sees their own.
    expect(money.entries.at(-1)?.reason).toBe('handover_refund');
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

describe('a free repair', () => {
  test('only an owner hands back a repaired phone that costs nothing, unless it is a claim', async () => {
    h = await openRepairHarness(7251);
    // Anyone may still take a phone in at Rp 0 to look at it first.
    const ticketId = await repaired(h, {
      quoteLines: [{ kind: 'labour', description: 'Cek dulu', amount: 0 }],
    });
    await expectRefused(
      h.run('returnDevice', handover(h, ticketId), h.cashierId),
      'PERMISSION_DENIED',
      'repair.refusal.freeHandoverOwnerOnly',
    );
    await h.run('returnDevice', handover(h, ticketId), h.ownerId);
    expect(await location(h, ticketId)).toBe('returned');
  });

  test('a cancelled phone at no fee still goes home with the counter', async () => {
    h = await openRepairHarness(7252);
    const ticketId = await openTicket(h, {
      quoteLines: [{ kind: 'labour', description: 'Cek dulu', amount: 0 }],
    });
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    expect(await location(h, ticketId)).toBe('returned');
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

describe('the bill the screens, the slip and the ledger agree on', () => {
  async function detail(harness: RepairHarness, ticketId: string): Promise<TicketDetailRow> {
    return (await harness.query('getTicket', { ticketId }, harness.cashierId))
      .rows[0] as TicketDetailRow;
  }

  test('an owner’s reduction on a debt comes off what the servisan and its slip say is left', async () => {
    h = await openRepairHarness(7601);
    const ticketId = await repaired(h, { downPayment: 100_000 });
    await h.run('returnDevice', handover(h, ticketId, { unpaidReason: 'Bayar Jumat' }), h.ownerId);
    await h.money(
      'reduceCharge',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        amount: 20_000,
        reason: 'Pelanggan tetap',
      },
      h.storeOwnerId,
    );
    const row = await detail(h, ticketId);
    const owed = (await ledger(h, ticketId)).balance;
    expect(owed).toBe(TOTAL - 100_000 - 20_000);
    expect(ticketBill(row)).toBe(TOTAL - 20_000);
    expect(ticketBalance(row)).toEqual({ kind: 'due', amount: owed });
    const slip = handoverSlip(row, {
      header: { name: 'Toko', lines: [], logo: null },
      terms: null,
      printedAt: 0,
      printedByName: null,
      handedOverByName: null,
      signature: null,
    });
    const totals = slip.aside!.flatMap((block) => (block.kind === 'amounts' ? block.totals : []));
    expect(totals.at(-1)?.amount).toBe(formatMoney(owed));
  });

  test('what goes back through each method is shown before the handover books it', async () => {
    h = await openRepairHarness(7602);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const qris = `account:${accountId}`;
    const ticketId = await openTicket(h, { downPayment: 100_000 });
    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: qris, amount: 100_000 }],
      },
      h.cashierId,
    );
    await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
    const before = await detail(h, ticketId);
    expect(ticketBalance(before)).toEqual({ kind: 'refund', amount: 150_000 });
    expect(before.refunds).toEqual([
      { account: 'cash', name: null, amount: 50_000 },
      { account: qris, name: 'QRIS toko', amount: 100_000 },
    ]);

    await h.run('returnDevice', handover(h, ticketId), h.cashierId);
    const booked = (await ledger(h, ticketId)).entries.filter((e) => e.kind === 'refund_paid');
    expect(booked.map(({ account, amount }) => ({ account, amount }))).toEqual(
      before.refunds.map(({ account, amount }) => ({ account, amount })),
    );
    // Once handed back, nothing is left to give back.
    expect((await detail(h, ticketId)).refunds).toEqual([]);
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

  test('raising a DP through another method keeps the cash and records only the difference', async () => {
    h = await openRepairHarness(7404);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const ticketId = await openTicket(h, { downPayment: 200_000 });
    await h.run(
      'correctDownPayment',
      { ticketId, amount: 500_000, reason: 'Tambah lewat QRIS', account: `account:${accountId}` },
      h.storeOwnerId,
    );
    const money = await ledger(h, ticketId);
    expect(money.paid).toBe(500_000);
    const live = money.entries.filter(
      (entry) => entry.kind === 'payment_received' && entry.voidedAt === null,
    );
    expect(live.map((entry) => [entry.account, entry.amount])).toEqual([
      ['cash', 200_000],
      [`account:${accountId}`, 300_000],
    ]);
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

describe('payLaterOffer', () => {
  test('a limited role is offered a debt only up to its limit, and a limit of 0 is none', () => {
    const none = { offered: false, limit: null, overLimit: false };
    expect(payLaterOffer(false, null, 50_000)).toEqual(none);
    expect(payLaterOffer(true, 0, 10_000)).toEqual(none);
    expect(payLaterOffer(true, null, 5_000_000)).toEqual({
      offered: true,
      limit: null,
      overLimit: false,
    });
    expect(payLaterOffer(true, 100_000, 100_000)).toEqual({
      offered: true,
      limit: 100_000,
      overLimit: false,
    });
    expect(payLaterOffer(true, 100_000, 100_001)).toEqual({
      offered: false,
      limit: 100_000,
      overLimit: true,
    });
  });
});
