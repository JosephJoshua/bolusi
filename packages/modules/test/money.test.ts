// The money ledger through the real runtime: charges checked against the servisan, payments,
// refunds, voids, the drawer and its counts, and the owner-only limits that keep cash from going
// missing. Every record must leave the books balanced.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import { MONEY_OP } from '../src/money/index.js';
import type { MoneyEntryRow } from '../src/money/queries.js';
import { REPAIR_DOCUMENT_KIND } from '../src/repair/index.js';
import { openRepairHarness, intake, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(`money.refusal.${refusal}`);
}

const TOTAL = 750_000;

async function openTicket(harness: RepairHarness) {
  const { ticketId, ticketNumber } = (await harness.run(
    'openTicket',
    intake(harness),
    harness.cashierId,
  )) as { ticketId: string; ticketNumber: string };
  return { kind: REPAIR_DOCUMENT_KIND, id: ticketId, label: ticketNumber };
}

async function repaired(harness: RepairHarness) {
  const document = await openTicket(harness);
  await harness.run(
    'startWork',
    { ticketId: document.id, beforePhotos: [harness.photo(20)] },
    harness.technicianId,
  );
  await harness.run(
    'markRepaired',
    { ticketId: document.id, afterPhotos: [harness.photo(21)] },
    harness.technicianId,
  );
  return document;
}

async function documentMoney(harness: RepairHarness, document: { kind: string; id: string }) {
  return (
    await harness.moneyQuery(
      'documentMoney',
      { kind: document.kind, id: document.id },
      harness.cashierId,
    )
  ).rows[0];
}

/** The whole ledger balances, and so does every entry. */
async function expectBalancedBooks(harness: RepairHarness): Promise<void> {
  const { rows } = await sql<{ entry: string; net: number }>`
    SELECT entry_id AS entry, SUM(debit) - SUM(credit) AS net FROM money_lines GROUP BY entry_id
  `.execute(harness.db);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(Number(row.net), row.entry).toBe(0);
}

/** Record charges and payments through the op builders, as a module's command does. */
async function charge(harness: RepairHarness, document: object, amount: number, userId: string) {
  // The money module has no charge command of its own: a business module records charges inside
  // its own command. The ledger's rule still judges each one, so drive it through the runtime.
  const { chargeOp } = await import('../src/money/index.js');
  const ctx = harness.runtime.commands.createContext(userId);
  return harness.runtime.commands.execute(
    {
      permission: 'money.receive',
      input: { parse: (x: unknown) => x },
      handler: (_input: unknown, c: typeof ctx) => ({
        ops: [chargeOp(c, document as never, amount, 'service_revenue')],
        result: null,
      }),
    } as never,
    {} as never,
    ctx,
  );
}

describe('charges follow the servisan', () => {
  test('a repaired servisan is charged exactly its agreed price, once', async () => {
    h = await openRepairHarness(501);
    const document = await openTicket(h);
    await expectRefused(
      charge(h, document, TOTAL, h.cashierId),
      'INVALID_TRANSITION',
      'notChargeable',
    );

    await h.run(
      'startWork',
      { ticketId: document.id, beforePhotos: [h.photo(20)] },
      h.technicianId,
    );
    await h.run(
      'markRepaired',
      { ticketId: document.id, afterPhotos: [h.photo(21)] },
      h.technicianId,
    );
    // Less than the price would let the counter hand back the difference as an "overpayment".
    await expectRefused(
      charge(h, document, TOTAL - 50_000, h.cashierId),
      'VALIDATION_FAILED',
      'chargeMismatch',
    );
    await charge(h, document, TOTAL, h.cashierId);
    await expectRefused(charge(h, document, 1, h.cashierId), 'VALIDATION_FAILED', 'chargeMismatch');

    const money = await documentMoney(h, document);
    expect(money).toMatchObject({ balance: TOTAL, charged: TOTAL, paid: 0 });
    await expectBalancedBooks(h);
  });

  test('a debt (charged, unpaid) shows on the unpaid list until it is paid', async () => {
    h = await openRepairHarness(502);
    const document = await repaired(h);
    await charge(h, document, TOTAL, h.cashierId);
    const before = await h.moneyQuery('openBalances', {}, h.cashierId);
    expect(before.rows).toMatchObject([{ documentId: document.id, balance: TOTAL }]);

    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: TOTAL }] },
      h.cashierId,
    );
    expect((await h.moneyQuery('openBalances', {}, h.cashierId)).rows).toEqual([]);
  });
});

describe('payments', () => {
  test("each record carries the name of who recorded it, from the device's staff list", async () => {
    h = await openRepairHarness(530);
    const document = await openTicket(h);
    await h.db
      .insertInto('usersDirectory')
      .values({ id: h.cashierId, name: 'Dewi', status: 'active', photoMediaId: null })
      .execute();
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 50_000 }] },
      h.cashierId,
    );
    const { rows } = await h.moneyQuery(
      'moneyEntries',
      { from: 0, to: Date.now() + 60_000 },
      h.cashierId,
    );
    const paid = (rows as MoneyEntryRow[]).find((row) => row.kind === 'payment_received')!;
    expect(paid.createdByName).toBe('Dewi');
    expect((await documentMoney(h, document)).entries[0]).toMatchObject({ createdByName: 'Dewi' });
  });

  test('a DP paid ahead leaves the servisan in credit, and a split pays the rest', async () => {
    h = await openRepairHarness(503);
    const document = await openTicket(h);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 200_000, tendered: 250_000 }] },
      h.cashierId,
    );
    expect(await documentMoney(h, document)).toMatchObject({ balance: -200_000 });
    // Paid ahead is not a debt.
    expect((await h.moneyQuery('openBalances', {}, h.cashierId)).rows).toEqual([]);

    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS BCA toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    await h.run(
      'startWork',
      { ticketId: document.id, beforePhotos: [h.photo(20)] },
      h.technicianId,
    );
    await h.run(
      'markRepaired',
      { ticketId: document.id, afterPhotos: [h.photo(21)] },
      h.technicianId,
    );
    await charge(h, document, TOTAL, h.cashierId);
    await h.money(
      'receivePayments',
      {
        document,
        payments: [
          { account: 'cash', amount: 300_000 },
          { account: `account:${accountId}`, amount: 250_000 },
        ],
      },
      h.cashierId,
    );
    const money = await documentMoney(h, document);
    expect(money).toMatchObject({ balance: 0, charged: TOTAL, paid: TOTAL });
    expect(money.entries.map((e: { kind: string }) => e.kind)).toEqual([
      'payment_received',
      'charge_recorded',
      'payment_received',
      'payment_received',
    ]);
    await expectBalancedBooks(h);
  });

  test('payments go only through accounts this store uses, and EDC needs its approval code', async () => {
    h = await openRepairHarness(504);
    const document = await openTicket(h);
    const pay = (payment: object) =>
      h!.money('receivePayments', { document, payments: [payment] }, h!.cashierId);

    await expectRefused(
      pay({ account: 'account:01920000-0000-7000-8000-0000000000aa', amount: 10_000 }),
      'VALIDATION_FAILED',
      'accountNotUsable',
    );
    const edc = (await h.money(
      'saveAccount',
      { kind: 'edc', name: 'EDC Mandiri' },
      h.storeOwnerId,
    )) as {
      accountId: string;
    };
    await expectRefused(
      pay({ account: `account:${edc.accountId}`, amount: 10_000 }),
      'VALIDATION_FAILED',
      'referenceRequired',
    );
    await pay({ account: `account:${edc.accountId}`, amount: 10_000, reference: '004512' });
    await expectRefused(
      pay({ account: 'cash', amount: 10_000, tendered: 5_000 }),
      'VALIDATION_FAILED',
      'tenderedTooLow',
    );

    // A hidden account takes no new payments.
    await h.money(
      'saveAccount',
      { accountId: edc.accountId, kind: 'edc', name: 'EDC Mandiri', active: false },
      h.storeOwnerId,
    );
    await expectRefused(
      pay({ account: `account:${edc.accountId}`, amount: 10_000, reference: '1' }),
      'VALIDATION_FAILED',
      'accountNotUsable',
    );
    // An account keeps its kind, and only owners set accounts up.
    await expectRefused(
      h.money('saveAccount', { accountId: edc.accountId, kind: 'qris', name: 'x' }, h.storeOwnerId),
      'VALIDATION_FAILED',
      'accountKindChanged',
    );
    await expectRefused(
      h.money('saveAccount', { kind: 'qris', name: 'QRIS' }, h.cashierId),
      'PERMISSION_DENIED',
    );
  });

  test('a central account is usable only in the stores it names', async () => {
    h = await openRepairHarness(505);
    const document = await openTicket(h);
    const otherStore = '01920000-0000-7000-8000-0000000000bb';
    const { accountId } = (await h.money(
      'saveCentralAccount',
      { kind: 'transfer', name: 'BCA pusat', storeIds: [otherStore] },
      h.ownerId,
    )) as { accountId: string };
    const pay = () =>
      h!.money(
        'receivePayments',
        { document, payments: [{ account: `account:${accountId}`, amount: 10_000 }] },
        h!.cashierId,
      );
    await expectRefused(pay(), 'VALIDATION_FAILED', 'accountNotUsable');
    expect((await h.moneyQuery('paymentAccounts', {}, h.cashierId)).rows).toEqual([]);
    // The business owner's Settings still lists it, to give it to this store too; nobody else's.
    const everyStore = { includeInactive: true, everyStore: true };
    expect((await h.moneyQuery('paymentAccounts', everyStore, h.ownerId)).rows).toMatchObject([
      { id: accountId, storeIds: [otherStore] },
    ]);
    expect((await h.moneyQuery('paymentAccounts', everyStore, h.storeOwnerId)).rows).toEqual([]);

    await h.money(
      'saveCentralAccount',
      { accountId, kind: 'transfer', name: 'BCA pusat', storeIds: [] },
      h.ownerId,
    );
    await pay();
    expect((await h.moneyQuery('paymentAccounts', {}, h.cashierId)).rows).toMatchObject([
      { id: accountId, central: true, name: 'BCA pusat' },
    ]);
    // A store owner cannot change the franchise's accounts.
    await expectRefused(
      h.money('saveCentralAccount', { accountId, kind: 'transfer', name: 'x' }, h.storeOwnerId),
      'PERMISSION_DENIED',
    );
  });
});

describe('refunds and voids are guarded', () => {
  test('the counter gives back only an overpayment, through the account it came in by', async () => {
    h = await openRepairHarness(506);
    const document = await repaired(h);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    // A transfer nobody can see yet: it must not come back out of the drawer as cash.
    await h.money(
      'receivePayments',
      { document, payments: [{ account: `account:${accountId}`, amount: TOTAL + 300_000 }] },
      h.cashierId,
    );
    const refund = (account: string, amount: number, userId = h!.cashierId) =>
      h!.money('refund', { document, account, amount, reason: 'Kelebihan bayar' }, userId);
    // Before the charge, everything paid is still a DP: only an owner hands it back.
    await expectRefused(refund(`account:${accountId}`, 300_000), 'PERMISSION_DENIED', 'notCharged');
    await charge(h, document, TOTAL, h.cashierId);
    await expectRefused(refund('cash', 300_000), 'PERMISSION_DENIED', 'refundAboveCredit');
    await expectRefused(
      refund(`account:${accountId}`, 300_001),
      'PERMISSION_DENIED',
      'refundAboveCredit',
    );
    await refund(`account:${accountId}`, 300_000);
    expect(await documentMoney(h, document)).toMatchObject({ balance: 0 });
    await expectBalancedBooks(h);
  });

  test('credit made by a transfer goes back through it, never out of the drawer', async () => {
    h = await openRepairHarness(517);
    const document = await openTicket(h);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const transfer = `account:${accountId}`;
    // A real cash DP, then the whole bill by a transfer nobody can see yet.
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 200_000 }] },
      h.cashierId,
    );
    await h.run(
      'startWork',
      { ticketId: document.id, beforePhotos: [h.photo(20)] },
      h.technicianId,
    );
    await h.run(
      'markRepaired',
      { ticketId: document.id, afterPhotos: [h.photo(21)] },
      h.technicianId,
    );
    await charge(h, document, TOTAL, h.cashierId);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: transfer, amount: TOTAL }] },
      h.cashierId,
    );
    const refund = (account: string, amount: number) =>
      h!.money('refund', { document, account, amount, reason: 'Kelebihan bayar' }, h!.cashierId);
    // The DP covered the bill first: the transfer is what overpaid.
    await expectRefused(refund('cash', 1), 'PERMISSION_DENIED', 'refundAboveCredit');
    await refund(transfer, 200_000);
    expect(await documentMoney(h, document)).toMatchObject({ balance: 0 });
    await expectBalancedBooks(h);
  });

  test('an owner gives back a DP, even through an account the store no longer uses', async () => {
    h = await openRepairHarness(511);
    const document = await openTicket(h);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS lama' },
      h.storeOwnerId,
    )) as { accountId: string };
    const account = `account:${accountId}`;
    await h.money(
      'receivePayments',
      { document, payments: [{ account, amount: 100_000 }] },
      h.cashierId,
    );
    await h.money(
      'saveAccount',
      { accountId, kind: 'qris', name: 'QRIS lama', active: false },
      h.storeOwnerId,
    );
    const refund = { document, account, amount: 100_000, reason: 'Batal servis' };
    await expectRefused(h.money('refund', refund, h.cashierId), 'PERMISSION_DENIED');
    await h.money('refund', refund, h.storeOwnerId);
    expect(await documentMoney(h, document)).toMatchObject({ balance: 0, paid: 0 });
    await expectBalancedBooks(h);
  });

  test('a voided payment does not open an account the store no longer uses for a refund', async () => {
    h = await openRepairHarness(519);
    const document = await openTicket(h);
    const { accountId } = (await h.money(
      'saveCentralAccount',
      { kind: 'transfer', name: 'BCA pusat', storeIds: [] },
      h.ownerId,
    )) as { accountId: string };
    const account = `account:${accountId}`;
    const { entryIds } = (await h.money(
      'receivePayments',
      { document, payments: [{ account, amount: 100_000 }] },
      h.cashierId,
    )) as { entryIds: string[] };
    await h.money('voidPayment', { entryId: entryIds[0]!, reason: 'Salah metode' }, h.storeOwnerId);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 100_000 }] },
      h.cashierId,
    );
    // The main owner gives the account to another store only.
    await h.money(
      'saveCentralAccount',
      {
        accountId,
        kind: 'transfer',
        name: 'BCA pusat',
        storeIds: ['01920000-0000-7000-8000-0000000000bb'],
      },
      h.ownerId,
    );
    // The customer paid in cash: the voided transfer took no money that still counts.
    await expectRefused(
      h.money(
        'refund',
        { document, account, amount: 100_000, reason: 'Batal servis' },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
      'accountNotUsable',
    );
  });

  test('money goes back through a central account the customer paid with, even once unshared', async () => {
    h = await openRepairHarness(518);
    const document = await openTicket(h);
    const { accountId } = (await h.money(
      'saveCentralAccount',
      { kind: 'transfer', name: 'BCA pusat', storeIds: [] },
      h.ownerId,
    )) as { accountId: string };
    const account = `account:${accountId}`;
    await h.money(
      'receivePayments',
      { document, payments: [{ account, amount: 100_000 }] },
      h.cashierId,
    );
    // The main owner gives the account to another store only.
    await h.money(
      'saveCentralAccount',
      {
        accountId,
        kind: 'transfer',
        name: 'BCA pusat',
        storeIds: ['01920000-0000-7000-8000-0000000000bb'],
      },
      h.ownerId,
    );
    // No new payment goes through it here, but the DP still goes back the way it came.
    await expectRefused(
      h.money('receivePayments', { document, payments: [{ account, amount: 1 }] }, h.cashierId),
      'VALIDATION_FAILED',
      'accountNotUsable',
    );
    await h.money(
      'refund',
      { document, account, amount: 100_000, reason: 'Batal servis' },
      h.storeOwnerId,
    );
    expect(await documentMoney(h, document)).toMatchObject({ balance: 0, paid: 0 });
    await expectBalancedBooks(h);
  });

  test("an owner's refund beyond the credit takes the rest off the bill, so nobody owes it", async () => {
    h = await openRepairHarness(507);
    const document = await repaired(h);
    await charge(h, document, TOTAL, h.cashierId);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: TOTAL }] },
      h.cashierId,
    );
    // The customer came back unhappy; the owner gives back 100k.
    await expectRefused(
      h.money(
        'refund',
        { document, account: 'cash', amount: 100_000, reason: 'Komplain' },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
      'refundAboveCredit',
    );
    await h.money(
      'refund',
      { document, account: 'cash', amount: 100_000, reason: 'Komplain' },
      h.storeOwnerId,
    );
    expect(await documentMoney(h, document)).toMatchObject({
      balance: 0,
      charged: TOTAL,
      reduced: 100_000,
      paid: TOTAL - 100_000,
    });
    // The servisan's slip reads the same reduction, so its bill matches the ledger.
    const ticket = (await h.query('getTicket', { ticketId: document.id }, h.cashierId)).rows[0];
    expect(ticket).toMatchObject({ reduced: 100_000 });
    await expectRefused(
      h.money('reduceCharge', { document, amount: TOTAL, reason: 'x' }, h.storeOwnerId),
      'VALIDATION_FAILED',
      'aboveCharged',
    );
    // Not even an owner gives back more than the customer paid.
    await expectRefused(
      h.money(
        'refund',
        { document, account: 'cash', amount: TOTAL - 100_000 + 1, reason: 'x' },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
      'refundAbovePaid',
    );
    await expectBalancedBooks(h);
  });

  test('an owner gives back nothing on a debt the customer never paid', async () => {
    h = await openRepairHarness(515);
    const document = await repaired(h);
    // Bayar nanti: charged, nothing paid. A refund would hand out cash and forgive the debt.
    await charge(h, document, TOTAL, h.cashierId);
    await expectRefused(
      h.money(
        'refund',
        { document, account: 'cash', amount: 100_000, reason: 'Komplain' },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
      'refundAbovePaid',
    );
    // Part paid: what came in, and no more, can go back.
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 50_000 }] },
      h.cashierId,
    );
    await expectRefused(
      h.money(
        'refund',
        { document, account: 'cash', amount: 50_001, reason: 'Komplain' },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
      'refundAbovePaid',
    );
    await h.money(
      'refund',
      { document, account: 'cash', amount: 50_000, reason: 'Komplain' },
      h.storeOwnerId,
    );
    expect(await documentMoney(h, document)).toMatchObject({ balance: TOTAL - 50_000, paid: 0 });
    await expectBalancedBooks(h);
  });

  test('the server refuses refunds beyond what was paid, even an owner’s from two phones', async () => {
    h = await openRepairHarness(516);
    const document = await repaired(h);
    await charge(h, document, TOTAL, h.cashierId);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: TOTAL }] },
      h.cashierId,
    );
    // Each phone's command saw the whole payment; their refunds arrive one after the other. The
    // rule alone must hold, so drive the refund op past the command.
    const { refundOp } = await import('../src/money/index.js');
    const ownerRefund = () => {
      const ctx = h!.runtime.commands.createContext(h!.storeOwnerId);
      return h!.runtime.commands.execute(
        {
          permission: 'money.refund',
          input: { parse: (x: unknown) => x },
          handler: (_input: unknown, c: typeof ctx) => ({
            ops: [
              refundOp(c, document as never, {
                account: 'cash',
                amount: 400_000,
                reason: 'Komplain',
                reference: null,
              }),
            ],
            result: null,
          }),
        } as never,
        {} as never,
        ctx,
      );
    };
    await ownerRefund();
    await expectRefused(ownerRefund(), 'VALIDATION_FAILED', 'refundAbovePaid');
    expect(await documentMoney(h, document)).toMatchObject({ paid: TOTAL - 400_000 });
    await expectBalancedBooks(h);
  });

  test('only an owner voids a payment, once, and the void reverses its lines', async () => {
    h = await openRepairHarness(508);
    const document = await openTicket(h);
    const { entryIds } = (await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 50_000 }] },
      h.cashierId,
    )) as { entryIds: string[] };
    const entryId = entryIds[0]!;
    await expectRefused(
      h.money('voidPayment', { entryId, reason: 'Salah ketik' }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await h.money('voidPayment', { entryId, reason: 'Salah ketik' }, h.storeOwnerId);
    await expectRefused(
      h.money('voidPayment', { entryId, reason: 'Lagi' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'alreadyVoided',
    );
    const money = await documentMoney(h, document);
    expect(money).toMatchObject({ balance: 0 });
    expect(money.entries[0]).toMatchObject({ voidedBy: h.storeOwnerId, voidReason: 'Salah ketik' });
    await expectBalancedBooks(h);
  });
});

describe('the drawer', () => {
  test('an owner cancels a cash move typed wrong, and a later count reads right again', async () => {
    h = await openRepairHarness(531);
    const drawer = async () => (await h!.moneyQuery('cashDrawer', {}, h!.cashierId)).rows[0];
    await h.money('moveCash', { kind: 'float', amount: 500_000, reason: 'Kembalian' }, h.cashierId);
    const { entryId: wrong } = (await h.money(
      'moveCash',
      { kind: 'float', amount: 5_000_000, reason: 'Kembalian' },
      h.cashierId,
    )) as { entryId: string };
    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 500_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    expect((await drawer()).counts[0]).toMatchObject({ id: countId, difference: -5_000_000 });

    const cancel = { entryId: wrong, reason: 'Salah ketik, harusnya tidak ada' };
    await expectRefused(h.money('voidCashMove', cancel, h.cashierId), 'PERMISSION_DENIED');
    await h.money('voidCashMove', cancel, h.storeOwnerId);
    const after = await drawer();
    expect(after.expected).toBe(500_000);
    // As if it was never recorded: no shortage to settle, nothing that reads like theft.
    expect(after.counts[0]).toMatchObject({ id: countId, expected: 500_000, difference: 0 });
    await expectRefused(
      h.money('voidCashMove', cancel, h.storeOwnerId),
      'INVALID_TRANSITION',
      'alreadyVoided',
    );
    await expectBalancedBooks(h);
  });

  test('a cash move is not cancelled once a later count was settled, nor is a payment this way', async () => {
    h = await openRepairHarness(532);
    const document = await openTicket(h);
    const { entryIds } = (await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 100_000 }] },
      h.cashierId,
    )) as { entryIds: string[] };
    await expectRefused(
      h.money('voidCashMove', { entryId: entryIds[0]!, reason: 'x' }, h.storeOwnerId),
      'ENTITY_NOT_FOUND',
      'cashMoveNotFound',
    );
    const { entryId: move } = (await h.money(
      'moveCash',
      { kind: 'expense', amount: 20_000, reason: 'Bensin' },
      h.cashierId,
    )) as { entryId: string };
    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 70_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    await h.money('adjustCash', { amount: -10_000, countId, reason: 'Kurang' }, h.storeOwnerId);
    await expectRefused(
      h.money('voidCashMove', { entryId: move, reason: 'Salah' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'laterCountSettled',
    );
  });

  test('a count shows the difference against the book, and only an owner settles it', async () => {
    h = await openRepairHarness(509);
    const document = await openTicket(h);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 100_000 }] },
      h.cashierId,
    );
    await h.money('moveCash', { kind: 'expense', amount: 20_000, reason: 'Bensin' }, h.cashierId);
    await h.money(
      'moveCash',
      { kind: 'float', amount: 50_000, reason: 'Uang kembalian' },
      h.cashierId,
    );
    const drawer = async () => (await h!.moneyQuery('cashDrawer', {}, h!.cashierId)).rows[0];
    expect((await drawer()).expected).toBe(130_000);

    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 120_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    expect((await drawer()).counts).toMatchObject([
      { id: countId, counted: 120_000, expected: 130_000, difference: -10_000, settled: 0 },
    ]);

    const settle = { amount: -10_000, countId, reason: 'Kurang kembalian' };
    await expectRefused(h.money('adjustCash', settle, h.cashierId), 'PERMISSION_DENIED');
    await h.money('adjustCash', settle, h.storeOwnerId);
    const after = await drawer();
    expect(after.expected).toBe(120_000);
    expect(after.counts[0]).toMatchObject({ difference: -10_000, settled: -10_000 });
    // Settling the same count twice would move the book away from the drawer again.
    await expectRefused(
      h.money('adjustCash', { ...settle, reason: 'Lagi' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'countSettled',
    );
    await expectBalancedBooks(h);
  });

  test('only the latest count is settled: a later count finds the same difference again', async () => {
    h = await openRepairHarness(511);
    await h.money('moveCash', { kind: 'float', amount: 100_000, reason: 'Modal' }, h.cashierId);
    const count = async (counted: number) =>
      (
        (await h!.money('countCash', { counted, note: '' }, h!.cashierId)) as {
          entryId: string;
        }
      ).entryId;
    const first = await count(90_000);
    const second = await count(90_000);
    const drawer = (await h.moneyQuery('cashDrawer', {}, h.cashierId)).rows[0];
    // The same 10.000, found twice.
    expect(drawer.counts.map((c: { difference: number }) => c.difference)).toEqual([
      -10_000, -10_000,
    ]);
    await expectRefused(
      h.money('adjustCash', { amount: -10_000, countId: first, reason: 'Kurang' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'countSuperseded',
    );
    await h.money(
      'adjustCash',
      { amount: -10_000, countId: second, reason: 'Kurang' },
      h.storeOwnerId,
    );
    expect((await h.moneyQuery('cashDrawer', {}, h.cashierId)).rows[0].expected).toBe(90_000);
    await expectBalancedBooks(h);
  });

  test('an adjustment always settles a count: one naming none is refused', async () => {
    h = await openRepairHarness(514);
    await h.money('moveCash', { kind: 'float', amount: 100_000, reason: 'Modal' }, h.cashierId);
    // A screen never sends one without a count, so drive the op past the command's input, as
    // another device's push would arrive.
    const { MONEY_OP: OP } = await import('../src/money/index.js');
    const ctx = h.runtime.commands.createContext(h.storeOwnerId);
    const unbound = h.runtime.commands.execute(
      {
        permission: 'money.adjust_cash',
        input: { parse: (x: unknown) => x },
        handler: (_input: unknown, c: typeof ctx) => ({
          ops: [
            c.op({
              type: OP.cashAdjusted,
              entityType: 'money_entry',
              entityId: c.newId(),
              payload: { amount: 50_000, countId: null, reason: 'Tambah' },
            }),
          ],
          result: null,
        }),
      } as never,
      {} as never,
      ctx,
    );
    await expectRefused(unbound, 'VALIDATION_FAILED', 'countRequired');
    expect((await h.moneyQuery('cashDrawer', {}, h.cashierId)).rows[0].expected).toBe(100_000);
    // The command itself names the count it settles.
    await expectRefused(
      h.money('adjustCash', { amount: 50_000, reason: 'Tambah' }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });

  test('an owner settles the difference as it stands, not as an older screen showed it', async () => {
    h = await openRepairHarness(512);
    await h.money('moveCash', { kind: 'float', amount: 100_000, reason: 'Modal' }, h.cashierId);
    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 90_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    await expectRefused(
      h.money('adjustCash', { amount: -5_000, countId, reason: 'Kurang' }, h.storeOwnerId),
      'INVALID_TRANSITION',
      'differenceChanged',
    );
    await h.money('adjustCash', { amount: -10_000, countId, reason: 'Kurang' }, h.storeOwnerId);
    await expectBalancedBooks(h);
  });

  test('a count made before the owner settled, and synced after, already includes the correction', async () => {
    h = await openRepairHarness(513);
    await h.money('moveCash', { kind: 'float', amount: 100_000, reason: 'Modal' }, h.cashierId);
    const { entryId: first } = (await h.money(
      'countCash',
      { counted: 90_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    // Time passes before the owner looks: any record that leaves the drawer alone.
    await h.money('saveAccount', { kind: 'transfer', name: 'BRI toko' }, h.storeOwnerId);
    await h.money(
      'adjustCash',
      { amount: -10_000, countId: first, reason: 'Kurang' },
      h.storeOwnerId,
    );
    // Another phone counted the same 90.000 between the first count and the owner's correction,
    // and its count arrives only now.
    const ops = await h.ownOps();
    const counted = ops.find((op) => op.type === MONEY_OP.cashCounted)!;
    const settledAt = ops.find((op) => op.type === MONEY_OP.cashAdjusted)!.timestamp;
    const late = {
      ...counted,
      id: '01920000-0000-7000-8000-00000000c0de',
      entityId: '01920000-0000-7000-8000-00000000c0df',
      deviceId: '01920000-0000-7000-8000-00000000c0e0',
      timestamp: counted.timestamp + 1,
    };
    expect(late.timestamp).toBeLessThan(settledAt);
    await h.deliverPulled(late as never, 1);

    const drawer = (await h.moneyQuery('cashDrawer', {}, h.cashierId)).rows[0];
    expect(drawer.counts[0].id).toBe(late.entityId);
    // Nothing more to settle: the 10.000 the owner wrote off is the one this count found.
    expect(drawer.counts[0].difference).toBe(0);
    expect(drawer.expected).toBe(90_000);
  });

  test('a deposit goes into a store account; other moves touch only the drawer', async () => {
    h = await openRepairHarness(510);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    await h.money('moveCash', { kind: 'float', amount: 10_000, reason: 'Modal' }, h.cashierId);
    await expectRefused(
      h.money('moveCash', { kind: 'deposit', amount: 10_000, reason: 'Setor bank' }, h.cashierId),
      'VALIDATION_FAILED',
      'accountNotUsable',
    );
    await h.money(
      'moveCash',
      { kind: 'deposit', amount: 10_000, reason: 'Setor bank', account: `account:${accountId}` },
      h.cashierId,
    );
    await expectRefused(
      h.money('moveCash', { kind: 'withdrawal', amount: 10_000, reason: 'x' }, h.technicianId),
      'PERMISSION_DENIED',
    );
    const { rows } = await sql<{ account: string; net: number }>`
      SELECT account, SUM(debit - credit) AS net FROM money_lines GROUP BY account ORDER BY account
    `.execute(h.db);
    expect(rows.map((r) => [r.account, Number(r.net)])).toEqual([
      [`account:${accountId}`, 10_000],
      ['cash', 0],
      ['owner_capital', -10_000],
    ]);
  });

  test('cash out above what the drawer holds is stopped on the device, for whoever sees the drawer', async () => {
    h = await openRepairHarness(514);
    await h.money('moveCash', { kind: 'float', amount: 700_000, reason: 'Modal' }, h.cashierId);
    const out = (kind: string, amount: number) =>
      h!.money('moveCash', { kind, amount, reason: 'Setor ke pemilik' }, h!.storeOwnerId);
    await expectRefused(out('withdrawal', 900_000), 'VALIDATION_FAILED', 'moveAboveDrawer');
    await expectRefused(out('expense', 700_001), 'VALIDATION_FAILED', 'moveAboveDrawer');
    await out('withdrawal', 700_000);
    expect((await h.moneyQuery('cashDrawer', {}, h.cashierId)).rows[0].expected).toBe(0);
    // Putting change money in is never limited.
    await out('float', 50_000);
    await expectBalancedBooks(h);
  });

  test('someone who counts blind is not stopped, so a refusal cannot give the drawer away', async () => {
    h = await openRepairHarness(515);
    await h.money('moveCash', { kind: 'float', amount: 50_000, reason: 'Modal' }, h.cashierId);
    // Just above what is there is taken like any other amount; a wrong record shows at the count.
    await h.money('moveCash', { kind: 'expense', amount: 50_001, reason: 'Bensin' }, h.cashierId);
    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 0, note: '' },
      h.cashierId,
    )) as { entryId: string };
    const drawer = (await h.moneyQuery('cashDrawer', {}, h.storeOwnerId)).rows[0];
    expect(drawer.counts[0]).toMatchObject({ id: countId, expected: -1, difference: 1 });
    await expectBalancedBooks(h);
  });

  test("the store's records page through a period, newest first", async () => {
    h = await openRepairHarness(512);
    for (const amount of [1_000, 2_000, 3_000]) {
      await h.money('moveCash', { kind: 'float', amount, reason: 'Modal' }, h.cashierId);
    }
    const page = (cursor?: string) =>
      h!.moneyQuery(
        'moneyEntries',
        { from: 0, to: Date.now() + 60_000, limit: 2, ...(cursor === undefined ? {} : { cursor }) },
        h!.cashierId,
      );
    const first = await page();
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor!);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.rows, ...second.rows] as { amount: number; createdAt: number }[];
    expect(seen.map((row) => row.amount).sort()).toEqual([1_000, 2_000, 3_000]);
    expect(new Set(seen.map((row) => JSON.stringify(row))).size).toBe(3);
  });
});
