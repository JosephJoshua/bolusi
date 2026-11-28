// Several cash drawers in one store: each limited to some roles, counted and settled on its own,
// and cash moved between them only by someone who uses both. The rules judge every step, so a
// cashier of one drawer can neither take money into another nor push cash into it.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import { REPAIR_DOCUMENT_KIND } from '../src/repair/index.js';
import { openRepairHarness, intake, type RepairHarness } from './support/repair-harness.js';

const CASHIER_ROLE = 'role-cashier';
const MANAGER_ROLE = 'role-manager';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function expectRefused(p: Promise<unknown>, refusal: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${refusal}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(refusalKeyOf(err)).toBe(`money.refusal.${refusal}`);
}

/** An accessories drawer only the Manajer role uses. */
async function accessoriesDrawer(harness: RepairHarness): Promise<string> {
  const { drawer } = (await harness.money(
    'saveDrawer',
    { name: 'Laci aksesoris', roleIds: [MANAGER_ROLE] },
    harness.ownerId,
  )) as { drawer: string };
  return drawer;
}

async function drawer(harness: RepairHarness, ref: string, userId: string) {
  return (await harness.moneyQuery('cashDrawer', { drawer: ref }, userId)).rows[0] as
    | { expected: number; counts: { id: string; difference: number; expected: number }[] }
    | undefined;
}

async function ticket(harness: RepairHarness) {
  const { ticketId, ticketNumber } = (await harness.run(
    'openTicket',
    intake(harness),
    harness.cashierId,
  )) as { ticketId: string; ticketNumber: string };
  return { kind: REPAIR_DOCUMENT_KIND, id: ticketId, label: ticketNumber };
}

async function expectBalancedBooks(harness: RepairHarness): Promise<void> {
  const { rows } = await sql<{ entry: string; net: number }>`
    SELECT entry_id AS entry, SUM(debit) - SUM(credit) AS net FROM money_lines GROUP BY entry_id
  `.execute(harness.db);
  for (const row of rows) expect(Number(row.net), row.entry).toBe(0);
}

describe('drawers and who uses them', () => {
  test('each person sees which drawers are theirs; the main drawer is always listed first', async () => {
    h = await openRepairHarness(901);
    const accessories = await accessoriesDrawer(h);

    const forCashier = (await h.moneyQuery('drawers', {}, h.cashierId)).rows as {
      ref: string;
      main: boolean;
      usable: boolean;
      name: string | null;
    }[];
    expect(forCashier.map((row) => [row.ref, row.main, row.usable])).toEqual([
      ['cash', true, true],
      [accessories, false, false],
    ]);
    const forManager = (await h.moneyQuery('drawers', {}, h.managerId)).rows as {
      usable: boolean;
    }[];
    expect(forManager.map((row) => row.usable)).toEqual([true, true]);
    // Owners use every drawer.
    const forOwner = (await h.moneyQuery('drawers', {}, h.ownerId)).rows as { usable: boolean }[];
    expect(forOwner.every((row) => row.usable)).toBe(true);

    // A drawer is cash, not a way to pay: the payment methods leave it out.
    expect((await h.moneyQuery('paymentAccounts', {}, h.cashierId)).rows).toEqual([]);
  });

  test("a cashier can neither take a payment into, count nor read a drawer that isn't theirs", async () => {
    h = await openRepairHarness(902);
    const accessories = await accessoriesDrawer(h);
    const document = await ticket(h);

    await expectRefused(
      h.money(
        'receivePayments',
        { document, payments: [{ account: accessories, amount: 50_000 }] },
        h.cashierId,
      ),
      'drawerNotYours',
    );
    await expectRefused(
      h.money('countCash', { counted: 0, drawer: accessories }, h.cashierId),
      'drawerNotYours',
    );
    await expectRefused(
      h.money(
        'moveCash',
        { kind: 'float', amount: 10_000, reason: 'Modal', drawer: accessories },
        h.cashierId,
      ),
      'drawerNotYours',
    );
    expect(await drawer(h, accessories, h.cashierId)).toBeUndefined();

    // Their own drawer works as before.
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 50_000, tendered: 100_000 }] },
      h.cashierId,
    );
    expect((await drawer(h, 'cash', h.cashierId))?.expected).toBe(50_000);
  });

  test('limiting the main drawer keeps another role out of it too', async () => {
    h = await openRepairHarness(903);
    await h.money(
      'saveDrawer',
      { drawer: 'cash', name: 'Laci servis', roleIds: [CASHIER_ROLE] },
      h.ownerId,
    );
    const document = await ticket(h);
    await expectRefused(
      h.money(
        'receivePayments',
        { document, payments: [{ account: 'cash', amount: 20_000 }] },
        h.managerId,
      ),
      'drawerNotYours',
    );
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 20_000 }] },
      h.cashierId,
    );
    const main = (await h.moneyQuery('drawers', {}, h.cashierId)).rows[0] as { name: string };
    expect(main.name).toBe('Laci servis');
  });

  test("a manager cannot cancel a payment taken into a drawer that isn't theirs", async () => {
    h = await openRepairHarness(908);
    await h.money(
      'saveDrawer',
      { drawer: 'cash', name: 'Laci servis', roleIds: [CASHIER_ROLE] },
      h.ownerId,
    );
    const document = await ticket(h);
    await h.money(
      'receivePayments',
      { document, payments: [{ account: 'cash', amount: 10_000 }] },
      h.cashierId,
    );
    const paid = (await h.moneyQuery('moneyEntries', { from: 0, to: Date.now() + 1 }, h.ownerId))
      .rows as { id: string; kind: string }[];
    const payment = paid.find((row) => row.kind === 'payment_received')!;
    await expectRefused(
      h.money('voidPayment', { entryId: payment.id, reason: 'Salah' }, h.managerId),
      'drawerNotYours',
    );
  });

  test("records of a drawer someone doesn't use stay out of what they read", async () => {
    h = await openRepairHarness(909);
    const accessories = await accessoriesDrawer(h);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'edc', name: 'EDC Mandiri' },
      h.ownerId,
    )) as { accountId: string };
    await h.money(
      'moveCash',
      { kind: 'float', amount: 40_000, reason: 'Modal', drawer: accessories },
      h.managerId,
    );
    await h.money('moveCash', { kind: 'float', amount: 30_000, reason: 'Modal' }, h.cashierId);
    await h.money(
      'moveCash',
      {
        kind: 'transfer',
        amount: 10_000,
        reason: 'Kembalian',
        drawer: accessories,
        account: 'cash',
      },
      h.managerId,
    );
    const read = async (userId: string) =>
      (
        (await h!.moneyQuery('moneyEntries', { from: 0, to: Date.now() + 1 }, userId)).rows as {
          reason: string | null;
          subKind: string | null;
        }[]
      ).map((row) => `${row.subKind ?? ''}:${row.reason ?? ''}`);
    // The cashier sees their own float and the cash that came into their drawer, not the
    // accessories float.
    expect((await read(h.cashierId)).sort()).toEqual(['float:Modal', 'transfer:Kembalian']);
    expect(await read(h.managerId)).toHaveLength(3);
    // A payment account is not a drawer: its balance is not read as one.
    expect(await drawer(h, `account:${accountId}`, h.ownerId)).toBeUndefined();
  });

  test('the main drawer stays a drawer and stays on', async () => {
    h = await openRepairHarness(904);
    await expectRefused(
      h.money('saveDrawer', { drawer: 'cash', name: 'Laci', active: false }, h.ownerId),
      'mainDrawerStays',
    );
  });
});

describe('each drawer has its own book', () => {
  test('moves, counts and settling stay within the drawer they name', async () => {
    h = await openRepairHarness(905);
    const accessories = await accessoriesDrawer(h);
    await h.money(
      'moveCash',
      { kind: 'float', amount: 100_000, reason: 'Modal aksesoris', drawer: accessories },
      h.managerId,
    );
    await h.money(
      'moveCash',
      { kind: 'float', amount: 30_000, reason: 'Modal servis' },
      h.cashierId,
    );
    expect((await drawer(h, accessories, h.managerId))?.expected).toBe(100_000);
    expect((await drawer(h, 'cash', h.managerId))?.expected).toBe(30_000);

    // Short Rp 5.000 in the accessories drawer; the main drawer counts right.
    await h.money('countCash', { counted: 95_000, drawer: accessories }, h.managerId);
    await h.money('countCash', { counted: 30_000 }, h.cashierId);
    const accessoryCount = (await drawer(h, accessories, h.ownerId))!.counts[0]!;
    expect(accessoryCount.difference).toBe(-5_000);
    expect((await drawer(h, 'cash', h.ownerId))!.counts[0]!.difference).toBe(0);

    // The main drawer's later count does not supersede the accessories count: the owner settles it.
    await h.money(
      'adjustCash',
      { amount: -5_000, countId: accessoryCount.id, reason: 'Kurang' },
      h.ownerId,
    );
    expect((await drawer(h, accessories, h.ownerId))?.expected).toBe(95_000);
    expect((await drawer(h, 'cash', h.ownerId))?.expected).toBe(30_000);
    await expectBalancedBooks(h);
  });

  test('Pindah kas needs both drawers, and moves the cash from one book to the other', async () => {
    h = await openRepairHarness(906);
    const accessories = await accessoriesDrawer(h);
    await h.money('moveCash', { kind: 'float', amount: 50_000, reason: 'Modal' }, h.cashierId);

    // The cashier does not use the accessories drawer, so cannot push cash into it.
    await expectRefused(
      h.money(
        'moveCash',
        { kind: 'transfer', amount: 20_000, reason: 'Kembalian', account: accessories },
        h.cashierId,
      ),
      'drawerNotYours',
    );
    await expectRefused(
      h.money(
        'moveCash',
        { kind: 'transfer', amount: 20_000, reason: 'Kembalian', account: 'cash' },
        h.managerId,
      ),
      'sameDrawer',
    );
    const { entryId } = (await h.money(
      'moveCash',
      { kind: 'transfer', amount: 20_000, reason: 'Kembalian', account: accessories },
      h.managerId,
    )) as { entryId: string };
    expect((await drawer(h, 'cash', h.managerId))?.expected).toBe(30_000);
    expect((await drawer(h, accessories, h.managerId))?.expected).toBe(20_000);
    await expectBalancedBooks(h);

    // Once a count of the drawer it went to is settled, the transfer stands.
    await h.money('countCash', { counted: 19_000, drawer: accessories }, h.managerId);
    const count = (await drawer(h, accessories, h.ownerId))!.counts[0]!;
    await h.money('adjustCash', { amount: -1_000, countId: count.id, reason: 'Kurang' }, h.ownerId);
    await expectRefused(
      h.money('voidCashMove', { entryId, reason: 'Salah ketik' }, h.ownerId),
      'laterCountSettled',
    );
  });

  test('a deposit goes to a payment account, never to a drawer', async () => {
    h = await openRepairHarness(907);
    const accessories = await accessoriesDrawer(h);
    await h.money('moveCash', { kind: 'float', amount: 50_000, reason: 'Modal' }, h.ownerId);
    await expectRefused(
      h.money(
        'moveCash',
        { kind: 'deposit', amount: 20_000, reason: 'Setor', account: accessories },
        h.ownerId,
      ),
      'accountNotUsable',
    );
  });
});
