// Supplier payments ("Bayar supplier", transfers-bills-returns.md): an owner pays a supplier for a
// bill from the drawer, a store bank account or their own money. What a bill still owes, and the
// supplier's credit, are read from the payments. Drawer cash leaves the drawer's book only as the
// owner's payment says, and comes back only when that payment is cancelled.
import { sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import type { SignedOperation } from '@bolusi/schemas';

import enCatalog from '../purchasing/i18n/en.json' with { type: 'json' };
import idCatalog from '../purchasing/i18n/id.json' with { type: 'json' };
import { drawerMoves } from '../src/money/kas.js';
import type { MoneyEntryRow } from '../src/money/queries.js';
import { billOverdue, type BillDetailRow, type BillRow } from '../src/purchasing/bills/queries.js';
import { registerPurchasingCatalog } from '../src/purchasing/i18n.js';
import { allocate } from '../src/purchasing/payments/balances.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerPurchasingCatalog({ id: idCatalog, en: enCatalog });
});

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

const DAY = 86_400_000;
const BILLED_ON = Date.UTC(2026, 10, 20);

async function addSupplier(h: RepairHarness, name = 'Sumber Jaya'): Promise<string> {
  return (
    (await h.purchasing('addSupplier', { name, phone: null, note: null }, h.storeOwnerId)) as {
      supplierId: string;
    }
  ).supplierId;
}

/** A supplier with a part on the list, and a way to bill them any amount. */
async function supplierWithBills(h: RepairHarness) {
  const supplierId = await addSupplier(h);
  const { itemId } = (await h.runInventory(
    'addItem',
    { name: 'LCD Redmi Note 10', code: null, fits: [] },
    h.storeOwnerId,
  )) as { itemId: string };
  let n = 0;
  const record = async (amount: number, dueInDays: number | null = null) =>
    (
      (await h.purchasing(
        'recordBill',
        {
          supplierId,
          supplierRef: `INV-${String((n += 1))}`,
          billedOn: BILLED_ON + n * DAY,
          dueOn: dueInDays === null ? null : BILLED_ON + n * DAY + dueInDays * DAY,
          lines: [{ itemId, qty: 1, unitPrice: amount }],
        },
        h.ownerId,
      )) as { billId: string }
    ).billId;
  return { supplierId, record };
}

async function bill(h: RepairHarness, billId: string): Promise<BillDetailRow> {
  return (await h.purchasingQuery('getBill', { billId }, h.ownerId)).rows[0] as BillDetailRow;
}

async function drawer(h: RepairHarness): Promise<number> {
  return Number((await h.moneyQuery('cashDrawer', { counts: 0 }, h.ownerId)).rows[0].expected);
}

async function pay(
  h: RepairHarness,
  input: { supplierId: string; billId?: string | null; amount: number; source: string },
  userId = h.ownerId,
): Promise<string> {
  return ((await h.purchasing('paySupplier', input, userId)) as { paymentId: string }).paymentId;
}

/** A money entry's lines, as [account, debit, credit]. */
async function linesOf(h: RepairHarness, entryId: string): Promise<[string, number, number][]> {
  const lines = await h.db
    .selectFrom('moneyLines')
    .select(['account', 'debit', 'credit'])
    .where('entryId', '=', entryId)
    .orderBy('id')
    .execute();
  return lines.map((line) => [line.account, Number(line.debit), Number(line.credit)]);
}

async function expectBalancedBooks(h: RepairHarness): Promise<void> {
  const { rows } = await sql<{ entry: string; net: number }>`
    SELECT entry_id AS entry, SUM(debit) - SUM(credit) AS net FROM money_lines GROUP BY entry_id
  `.execute(h.db);
  for (const row of rows) expect(Number(row.net), row.entry).toBe(0);
}

describe('paying a bill', () => {
  test('from the drawer: the bill is paid down, the drawer drops and Kas reads "Bayar supplier"', async () => {
    const h = await harness(7401);
    await h.money('moveCash', { kind: 'float', amount: 1_000_000, reason: 'Modal' }, h.cashierId);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(700_000, 14);

    const paymentId = await pay(h, { supplierId, billId, amount: 300_000, source: 'cash' });
    expect(await bill(h, billId)).toMatchObject({
      total: 700_000,
      paid: 300_000,
      balance: 400_000,
    });
    expect(await drawer(h)).toBe(700_000);
    // Payable debited, the drawer credited, under the payment's own id.
    const lines = await h.db
      .selectFrom('moneyLines')
      .select(['account', 'debit', 'credit'])
      .where('entryId', '=', paymentId)
      .orderBy('id')
      .execute();
    expect(lines.map((line) => [line.account, Number(line.debit), Number(line.credit)])).toEqual([
      ['payable', 300_000, 0],
      ['cash', 0, 300_000],
    ]);

    // The counter sees the cash leave, with no supplier, bill or note on it.
    const entries = (
      await h.moneyQuery('moneyEntries', { from: 0, to: h.now() + DAY }, h.cashierId)
    ).rows as MoneyEntryRow[];
    const payout = entries.find((entry) => entry.id === paymentId)!;
    expect(payout).toMatchObject({ kind: 'supplier_paid', documentId: null, reason: null });
    expect(drawerMoves([payout])).toMatchObject([
      { label: 'money.kas.supplierPaid', delta: -300_000 },
    ]);
    // The rest, from a bank account: the bank is credited, the drawer untouched.
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BCA Toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const bankPayment = await pay(h, {
      supplierId,
      billId,
      amount: 400_000,
      source: `account:${accountId}`,
    });
    expect(await linesOf(h, bankPayment)).toEqual([
      ['payable', 400_000, 0],
      [`account:${accountId}`, 0, 400_000],
    ]);
    const bankEntry = (
      (await h.moneyQuery('moneyEntries', { from: 0, to: h.now() + DAY }, h.cashierId))
        .rows as MoneyEntryRow[]
    ).find((entry) => entry.id === bankPayment)!;
    expect(bankEntry).toMatchObject({ kind: 'supplier_paid', account: `account:${accountId}` });
    expect(drawerMoves([bankEntry])).toEqual([]);
    const paid = await bill(h, billId);
    expect(paid).toMatchObject({ paid: 700_000, balance: 0 });
    expect(paid.payments.map((p) => [p.sourceKind, p.accountName, p.amount])).toEqual([
      ['cash', null, 300_000],
      ['bank', 'BCA Toko', 400_000],
    ]);
    expect(await drawer(h)).toBe(700_000);
    await expectBalancedBooks(h);
  });

  test('from the owner’s own money, and paying more than owed leaves credit for the next bill', async () => {
    const h = await harness(7402);
    const { supplierId, record } = await supplierWithBills(h);
    const first = await record(200_000);
    const payment = await pay(h, { supplierId, billId: first, amount: 250_000, source: 'owner' });
    expect(await bill(h, first)).toMatchObject({
      paid: 200_000,
      balance: 0,
      supplierCredit: 50_000,
    });
    expect((await h.purchasingQuery('supplierCredit', { supplierId }, h.ownerId)).rows[0]).toEqual({
      credit: 50_000,
      owed: 0,
    });

    // A later bill takes the credit by itself.
    const second = await record(120_000);
    expect(await bill(h, second)).toMatchObject({
      paid: 50_000,
      fromCredit: 50_000,
      balance: 70_000,
      supplierCredit: 0,
    });
    // The owner's own money comes in as their capital: the drawer is untouched.
    expect(await linesOf(h, payment)).toEqual([
      ['payable', 250_000, 0],
      ['owner_capital', 0, 250_000],
    ]);
    expect(await drawer(h)).toBe(0);
    await expectBalancedBooks(h);
  });

  test('paid ahead of any bill, the credit pays bills in the order they fall due', async () => {
    const h = await harness(7403);
    const { supplierId, record } = await supplierWithBills(h);
    await pay(h, { supplierId, amount: 500_000, source: 'owner' });
    const later = await record(300_000, 30);
    const sooner = await record(400_000, 3);
    expect(await bill(h, sooner)).toMatchObject({ paid: 400_000, balance: 0 });
    expect(await bill(h, later)).toMatchObject({ paid: 100_000, balance: 200_000 });
  });

  test('a voided bill’s payments become the supplier’s credit', async () => {
    const h = await harness(7404);
    const { supplierId, record } = await supplierWithBills(h);
    const wrong = await record(200_000);
    await pay(h, { supplierId, billId: wrong, amount: 200_000, source: 'owner' });
    await h.purchasing('voidBill', { billId: wrong, reason: 'Nota dicatat dua kali' }, h.ownerId);
    const right = await record(150_000);
    expect(await bill(h, wrong)).toMatchObject({ status: 'void', paid: 0, balance: 0 });
    expect(await bill(h, right)).toMatchObject({ paid: 150_000, supplierCredit: 50_000 });
  });

  test('Belum lunas and Jatuh tempo list only what is still owed', async () => {
    const h = await harness(7405);
    const { supplierId, record } = await supplierWithBills(h);
    const paidOff = await record(100_000, 5);
    const overdue = await record(200_000, 1);
    const notYet = await record(300_000, 60);
    await pay(h, { supplierId, billId: paidOff, amount: 100_000, source: 'owner' });
    const today = BILLED_ON + 20 * DAY;
    const list = async (filter: string) =>
      ((await h.purchasingQuery('listBills', { filter, today }, h.ownerId)).rows as BillRow[]).map(
        (row) => row.id,
      );
    expect(await list('unpaid')).toEqual([overdue, notYet]);
    expect(await list('overdue')).toEqual([overdue]);
    expect(await list('open')).toEqual([overdue, paidOff, notYet]);
    expect(billOverdue({ dueOn: today - 1, balance: 1 }, today)).toBe(true);
    expect(billOverdue({ dueOn: today - 1, balance: 0 }, today)).toBe(false);
    expect(billOverdue({ dueOn: today, balance: 1 }, today)).toBe(false);
  });
});

describe('who pays and what is checked', () => {
  test('only an owner pays; store staff who buy cannot, nor read payments', async () => {
    const h = await harness(7406);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    await expectRefused(
      pay(h, { supplierId, billId, amount: 100_000, source: 'cash' }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await expectRefused(
      pay(h, { supplierId, billId, amount: 100_000, source: 'cash' }, h.managerId),
      'PERMISSION_DENIED',
    );
  });

  test('nobody who sees the drawer pays out more than is in it', async () => {
    const h = await harness(7407);
    await h.money('moveCash', { kind: 'float', amount: 50_000, reason: 'Modal' }, h.cashierId);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    await expectRefused(
      pay(h, { supplierId, billId, amount: 60_000, source: 'cash' }),
      'VALIDATION_FAILED',
      'money.refusal.moveAboveDrawer',
    );
    // From the owner's pocket the drawer does not matter.
    await pay(h, { supplierId, billId, amount: 60_000, source: 'owner' });
  });

  test('a bill of another supplier, a void bill, or an account that is not a bank is refused', async () => {
    const h = await harness(7408);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    const other = await addSupplier(h, 'Mitra Sel');
    await expectRefused(
      pay(h, { supplierId: other, billId, amount: 10_000, source: 'owner' }),
      'VALIDATION_FAILED',
      'purchasing.refusal.billOtherSupplier',
    );
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'qris', name: 'QRIS Toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    await expectRefused(
      pay(h, { supplierId, billId, amount: 10_000, source: `account:${accountId}` }),
      'VALIDATION_FAILED',
      'purchasing.refusal.sourceNotUsable',
    );
    await h.purchasing('voidBill', { billId, reason: 'Salah' }, h.ownerId);
    await expectRefused(
      pay(h, { supplierId, billId, amount: 10_000, source: 'owner' }),
      'INVALID_TRANSITION',
      'purchasing.refusal.billVoid',
    );
  });

  test('drawer cash leaves only as an owner’s payment says, once', async () => {
    const h = await harness(7409);
    await h.money('moveCash', { kind: 'float', amount: 500_000, reason: 'Modal' }, h.cashierId);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    const paymentId = await pay(h, { supplierId, billId, amount: 100_000, source: 'cash' });
    const payout = (await h.ownOps()).find((op) => op.type === 'money.supplier_paid')!;
    // Again under the same id: refused, so one payment takes cash out once.
    await expectRefused(h.checkRule(payout), 'VALIDATION_FAILED', 'money.refusal.alreadyRecorded');
    const forged = (entityId: string, change: Partial<SignedOperation> = {}) =>
      ({ ...payout, entityId, ...change }) as SignedOperation;
    // With no payment behind it, a bigger amount, or by someone else.
    await expectRefused(
      h.checkRule(forged('01900000-0000-7000-8000-0000000003aa')),
      'ENTITY_NOT_FOUND',
      'money.refusal.payoutNotFound',
    );
    await h.db.deleteFrom('moneyLines').where('entryId', '=', paymentId).execute();
    await h.db.deleteFrom('moneyEntries').where('id', '=', paymentId).execute();
    await expectRefused(
      h.checkRule(forged(paymentId, { payload: { amount: 400_000 } })),
      'VALIDATION_FAILED',
      'money.refusal.payoutNotFound',
    );
    await expectRefused(
      h.checkRule(
        forged(paymentId, {
          payload: { amount: 100_000, account: 'account:01900000-0000-7000-8000-0000000003ab' },
        }),
      ),
      'VALIDATION_FAILED',
      'money.refusal.payoutNotFound',
    );
    await expectRefused(
      h.checkRule(forged(paymentId, { userId: h.cashierId })),
      'VALIDATION_FAILED',
      'money.refusal.payoutNotFound',
    );
    await expect(h.checkRule(payout)).resolves.toBeUndefined();
  });
});

describe('cancelling a payment', () => {
  test('a drawer payment cancelled puts the cash back and the bill owes again', async () => {
    const h = await harness(7410);
    await h.money('moveCash', { kind: 'float', amount: 500_000, reason: 'Modal' }, h.cashierId);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    const paymentId = await pay(h, { supplierId, billId, amount: 100_000, source: 'cash' });
    expect(await drawer(h)).toBe(400_000);

    await h.purchasing('voidSupplierPayment', { paymentId, reason: 'Salah ketik' }, h.ownerId);
    expect(await drawer(h)).toBe(500_000);
    const after = await bill(h, billId);
    expect(after).toMatchObject({ paid: 0, balance: 100_000 });
    expect(after.payments[0]).toMatchObject({ voidReason: 'Salah ketik' });
    await expectRefused(
      h.purchasing('voidSupplierPayment', { paymentId, reason: 'Lagi' }, h.ownerId),
      'INVALID_TRANSITION',
      'purchasing.refusal.paymentVoided',
    );
    await expectBalancedBooks(h);
  });

  test('the drawer’s side is not cancelled on its own, nor after a later count was settled', async () => {
    const h = await harness(7411);
    await h.money('moveCash', { kind: 'float', amount: 500_000, reason: 'Modal' }, h.cashierId);
    const { supplierId, record } = await supplierWithBills(h);
    const billId = await record(100_000);
    const paymentId = await pay(h, { supplierId, billId, amount: 100_000, source: 'cash' });
    const payout = (await h.ownOps()).find((op) => op.type === 'money.supplier_paid')!;
    await expectRefused(
      h.checkRule({
        ...payout,
        id: '01900000-0000-7000-8000-0000000003bb',
        type: 'money.supplier_payment_voided',
        payload: { reason: 'Diam-diam' },
      } as SignedOperation),
      'INVALID_TRANSITION',
      'money.refusal.payoutNotFound',
    );

    const { entryId: countId } = (await h.money(
      'countCash',
      { counted: 390_000, note: '' },
      h.cashierId,
    )) as { entryId: string };
    await h.money('adjustCash', { amount: -10_000, countId, reason: 'Kurang' }, h.storeOwnerId);
    await expectRefused(
      h.purchasing('voidSupplierPayment', { paymentId, reason: 'Salah' }, h.ownerId),
      'INVALID_TRANSITION',
      'purchasing.refusal.drawerSettled',
    );
    // A payment from the owner's own money is no drawer's: it is cancelled after the count, and
    // its lines reversed.
    const owner = await pay(h, { supplierId, billId, amount: 30_000, source: 'owner' });
    await h.purchasing('voidSupplierPayment', { paymentId: owner, reason: 'Salah' }, h.ownerId);
    expect(await bill(h, billId)).toMatchObject({ paid: 100_000, balance: 0 });
    expect(await linesOf(h, owner)).toHaveLength(4);
    await expectBalancedBooks(h);
  });
});

describe('allocate', () => {
  const bills = [
    { id: 'a', supplierId: 's', total: 100, billedOn: 1, dueOn: 10, billNumber: 'TG-1' },
    { id: 'b', supplierId: 's', total: 100, billedOn: 2, dueOn: 5, billNumber: 'TG-2' },
    { id: 'c', supplierId: 't', total: 100, billedOn: 3, dueOn: null, billNumber: 'TG-3' },
  ];

  test('a payment pays its own bill first, and credit pays the soonest due', () => {
    const { paid, fromCredit, credit } = allocate(bills, [
      { supplierId: 's', billId: 'a', amount: 150 },
      { supplierId: 's', billId: null, amount: 30 },
    ]);
    expect(paid).toEqual(
      new Map([
        ['a', 100],
        ['b', 80],
      ]),
    );
    expect(fromCredit).toEqual(new Map([['b', 80]]));
    expect(credit).toEqual(new Map());
  });

  test('credit never crosses to another supplier, and the same records always read the same', () => {
    const payments = [
      { supplierId: 't', billId: null, amount: 30 },
      { supplierId: 's', billId: 'c', amount: 40 },
    ];
    const once = allocate(bills, payments);
    expect(once.paid).toEqual(
      new Map([
        ['c', 30],
        ['b', 40],
      ]),
    );
    expect(allocate([...bills].reverse(), [...payments].reverse())).toEqual(once);
  });
});
