// A cancelled servisan's fee, changed afterwards by an owner. The case it exists for: a counter
// offline hands the phone over and takes the bill while an owner cancels the same servisan on
// another device. The server keeps the handover and the cash (they happened) and refuses the charge
// (it no longer fits a cancelled servisan), so the store holds money nothing is charged for. Kas
// shows it as owed back, and the owner settles it by setting the fee (or giving the money back).
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeAll, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { amountOwed, repairAbilities, ticketActions } from '../src/repair/flows.js';

import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';
import { judgedStore } from './support/judged-store.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const TOTAL = 750_000;

async function expectRefused(p: Promise<unknown>, refusal: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${refusal}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(refusalKeyOf(err)).toBe(refusal);
}

/** A counter, an owner's phone (ahead of it), the server and a bystander. */
async function devices(seed: number) {
  const { first: counter, second: owner, ...rest } = await judgedStore(seed, open);
  return { counter, owner, ...rest };
}

async function ticketOf(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.ownerId)).rows[0];
}

async function openBalances(h: RepairHarness) {
  return (await h.moneyQuery('openBalances', {}, h.storeOwnerId)).rows;
}

async function dump(h: RepairHarness): Promise<Record<string, unknown[]>> {
  const db = h.db as unknown as Kysely<never>;
  const out: Record<string, unknown[]> = {};
  for (const table of ['repair_tickets', 'repair_ticket_events', 'money_entries', 'money_lines']) {
    const rows = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(db);
    out[table] = rows.rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
  }
  return out;
}

async function expectBalancedBooks(h: RepairHarness): Promise<void> {
  const { rows } = await sql<{ net: number | null }>`
    SELECT SUM(debit) - SUM(credit) AS net FROM money_lines
  `.execute(h.db);
  expect(Number(rows[0]!.net ?? 0)).toBe(0);
}

/**
 * A repaired servisan both devices know; then the owner cancels it for free and syncs, while the
 * counter, offline, hands it over with the bill paid in cash and syncs after.
 */
async function handedOverWhileCancelled(seed: number, counterSignsFirst: boolean) {
  const ctx = await devices(seed);
  const { counter, owner, push, pull } = ctx;
  const { ticketId } = (await counter.run('openTicket', intake(counter), counter.cashierId)) as {
    ticketId: string;
  };
  await counter.run(
    'startWork',
    { ticketId, beforePhotos: [counter.photo(20)] },
    counter.technicianId,
  );
  await counter.run(
    'markRepaired',
    { ticketId, afterPhotos: [counter.photo(21)] },
    counter.technicianId,
  );
  await push(counter);
  await pull(owner);

  // The owner's phone runs about 17 minutes ahead of the counter: moving the counter past it signs
  // the handover after the cancel; leaving it signs the handover first.
  if (!counterSignsFirst) counter.advance(2_000_000);
  await counter.run(
    'returnDevice',
    (await paidHandover(counter, ticketId)) as never,
    counter.cashierId,
  );
  await owner.run(
    'cancelTicket',
    { ticketId, reason: 'Pelanggan batal', fee: 0 },
    owner.storeOwnerId,
  );
  await push(owner);
  await push(counter);
  await pull(owner);
  await pull(counter);
  return { ...ctx, ticketId };
}

for (const counterSignsFirst of [false, true]) {
  const when = counterSignsFirst ? 'signed before the cancel' : 'signed after the cancel';

  test(`a paid handover ${when} keeps the cancel and shows the cash as owed back`, async () => {
    const { server, owner, other, refused, pull, ticketId } = await handedOverWhileCancelled(
      counterSignsFirst ? 811 : 801,
      counterSignsFirst,
    );
    // Only the charge is refused, and its copy says another device changed the servisan.
    expect(refused).toEqual(['money.charge_recorded:money.refusal.chargeMismatch']);

    // The counter's own charge comes off it once its push is refused (core sync folds that); here
    // the server and the devices that pull from it show what stands.
    for (const h of [server, owner]) {
      expect(await ticketOf(h, ticketId)).toMatchObject({
        outcome: 'cancelled',
        location: 'returned',
        cancelFee: 0,
        downPayment: TOTAL,
      });
      expect(await openBalances(h)).toMatchObject([{ documentId: ticketId, balance: -TOTAL }]);
      await expectBalancedBooks(h);
    }
    await pull(other);
    expect(await dump(other)).toStrictEqual(await dump(server));

    // The way out sits with the owner, beside the fee.
    const row = await ticketOf(owner, ticketId);
    const can = repairAbilities((p) => owner.hasPermission(owner.storeOwnerId, p));
    expect(ticketActions(row, can, owner.storeOwnerId)).toContain('changeCancelFee');
    const cashier = repairAbilities((p) => owner.hasPermission(owner.cashierId, p));
    expect(ticketActions(row, cashier, owner.cashierId)).not.toContain('changeCancelFee');
  });

  test(`after a handover ${when}, a new fee charges the customer and squares Kas`, async () => {
    const { server, owner, other, push, pull, refused, ticketId } = await handedOverWhileCancelled(
      counterSignsFirst ? 831 : 821,
      counterSignsFirst,
    );

    // The owner keeps the customer's money as the fee: it is charged, and nothing is owed.
    await owner.run(
      'changeCancelFee',
      { ticketId, fee: TOTAL, reason: 'Sudah dikerjakan, pelanggan setuju bayar' },
      owner.storeOwnerId,
    );
    await push(owner);
    expect(refused).toHaveLength(1);
    for (const h of [server, owner]) {
      expect(await ticketOf(h, ticketId)).toMatchObject({ outcome: 'cancelled', cancelFee: TOTAL });
      expect(await openBalances(h)).toEqual([]);
      await expectBalancedBooks(h);
    }
    await pull(other);
    expect(await dump(other)).toStrictEqual(await dump(server));
  });
}

test('a lower fee leaves the rest owed back until it is given back', async () => {
  const { server, owner, push, ticketId } = await handedOverWhileCancelled(841, false);
  await owner.run(
    'changeCancelFee',
    { ticketId, fee: 100_000, reason: 'Biaya cek saja' },
    owner.storeOwnerId,
  );
  await push(owner);
  for (const h of [server, owner]) {
    expect(await openBalances(h)).toMatchObject([{ documentId: ticketId, balance: -650_000 }]);
  }
  await owner.money(
    'refund',
    {
      document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
      account: 'cash',
      amount: 650_000,
      reason: 'Sisa uang dikembalikan',
    },
    owner.cashierId,
  );
  await push(owner);
  for (const h of [server, owner]) {
    expect(await openBalances(h)).toEqual([]);
    await expectBalancedBooks(h);
  }
});

test('a fee lowered after a paid cancel gives back the difference', async () => {
  const h = await openRepairHarness(851);
  open.push(h);
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
  await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
  expect(await ticketOf(h, ticketId)).toMatchObject({ cancelFee: 50_000, downPayment: 50_000 });

  await h.run('changeCancelFee', { ticketId, fee: 20_000, reason: 'Pelanggan lama' }, h.ownerId);
  // The fee stays what was charged; the bill comes down by the cut, as "Kurangi tagihan" does.
  const row = await ticketOf(h, ticketId);
  expect(row).toMatchObject({ cancelFee: 50_000, reduced: 30_000 });
  expect(amountOwed(row)).toBe(20_000);
  // The store owes the 30 000 back now; the cashier may give it.
  expect(await openBalances(h)).toMatchObject([{ documentId: ticketId, balance: -30_000 }]);
  await expectBalancedBooks(h);
});

test('a fee change on a servisan still in the store only sets what pickup will charge', async () => {
  const h = await openRepairHarness(861);
  open.push(h);
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
  await h.run('changeCancelFee', { ticketId, fee: 30_000, reason: 'Pelanggan lama' }, h.ownerId);
  expect(await ticketOf(h, ticketId)).toMatchObject({ cancelFee: 30_000 });
  expect(await openBalances(h)).toEqual([]);

  const handover = await paidHandover(h, ticketId);
  expect(handover['payments']).toEqual([{ account: 'cash', amount: 30_000 }]);
  await h.run('returnDevice', handover as never, h.cashierId);
  expect(await openBalances(h)).toEqual([]);
  await expectBalancedBooks(h);
});

test('only a cancelled servisan has a fee to change, and only when it changes', async () => {
  const h = await openRepairHarness(871);
  open.push(h);
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await expectRefused(
    h.run('changeCancelFee', { ticketId, fee: 10_000, reason: 'x' }, h.ownerId),
    'repair.refusal.notCancelled',
  );
  await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);
  await expectRefused(
    h.run('changeCancelFee', { ticketId, fee: 50_000, reason: 'x' }, h.ownerId),
    'repair.refusal.nothingChanged',
  );
  // A counter cannot change it.
  await expect(
    h.run('changeCancelFee', { ticketId, fee: 0, reason: 'x' }, h.cashierId),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

test('a manager lowers a fee only within the limit, counted from the store’s fee', async () => {
  const h = await openRepairHarness(881);
  open.push(h);
  await h.run('setCancelFees', { beforeWork: 100_000, afterWork: 150_000 }, h.storeOwnerId);
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await h.run('cancelTicket', { ticketId, reason: 'Batal' }, h.storeOwnerId);
  expect((await ticketOf(h, ticketId)).cancelFee).toBe(100_000);
  // Raising never counts against the limit.
  await h.run('changeCancelFee', { ticketId, fee: 110_000, reason: 'Cek tambahan' }, h.managerId);
  await h.run('changeCancelFee', { ticketId, fee: 50_000, reason: 'Pelanggan lama' }, h.managerId);
  // A second step down counts from the store's fee too, not from the last one.
  await expectRefused(
    h.run('changeCancelFee', { ticketId, fee: 49_999, reason: 'Gratis' }, h.managerId),
    'repair.refusal.overLimit',
  );
});

test('a fee change signed on a clock behind the cancel still folds to the new fee', async () => {
  const { counter, owner, server, other, push, pull } = await devices(891);
  const { ticketId } = (await counter.run('openTicket', intake(counter), counter.cashierId)) as {
    ticketId: string;
  };
  await push(counter);
  await pull(owner);
  // The owner's phone runs ahead: its cancel is signed after what the counter signs next.
  await owner.run('cancelTicket', { ticketId, reason: 'Batal', fee: 50_000 }, owner.storeOwnerId);
  await push(owner);
  await pull(counter);
  await counter.run('changeCancelFee', { ticketId, fee: 20_000, reason: 'Kenal' }, counter.ownerId);
  await push(counter);
  await pull(owner);

  for (const h of [server, owner, counter]) {
    expect(await ticketOf(h, ticketId)).toMatchObject({ outcome: 'cancelled', cancelFee: 20_000 });
  }
  await pull(other);
  expect(await dump(other)).toStrictEqual(await dump(server));
});

/** What the servisan says is left to pay (below zero: owed back), and what Kas says. */
async function bothSides(h: RepairHarness, ticketId: string) {
  const row = await ticketOf(h, ticketId);
  const kas = (await openBalances(h)).find(
    (b: { documentId: string }) => b.documentId === ticketId,
  );
  return { servisan: amountOwed(row) - (row.downPayment ?? 0), kas: kas?.balance ?? 0 };
}

/** Charged 70 000 as a cancel fee (the store's fee is 0), 50 000 of it paid, the rest owed. */
async function chargedCancel(seed: number) {
  const h = await openRepairHarness(seed);
  open.push(h);
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await h.run('cancelTicket', { ticketId, reason: 'Batal', fee: 70_000 }, h.storeOwnerId);
  await h.run(
    'returnDevice',
    (await paidHandover(h, ticketId, {
      payments: [{ account: 'cash', amount: 50_000 }],
      unpaidReason: 'Sisa minggu depan',
    })) as never,
    h.ownerId,
  );
  return { h, ticketId };
}

test('lowering then raising a charged fee keeps the servisan and Kas in step', async () => {
  const { h, ticketId } = await chargedCancel(897);
  expect(await bothSides(h, ticketId)).toEqual({ servisan: 20_000, kas: 20_000 });

  await h.run('changeCancelFee', { ticketId, fee: 50_000, reason: 'Kenal' }, h.ownerId);
  expect(await bothSides(h, ticketId)).toEqual({ servisan: 0, kas: 0 });

  await h.run('changeCancelFee', { ticketId, fee: 60_000, reason: 'Salah hitung' }, h.ownerId);
  expect(await bothSides(h, ticketId)).toEqual({ servisan: 10_000, kas: 10_000 });
  expect(amountOwed(await ticketOf(h, ticketId))).toBe(60_000);

  await h.run('changeCancelFee', { ticketId, fee: 40_000, reason: 'Pelanggan lama' }, h.ownerId);
  expect(await bothSides(h, ticketId)).toEqual({ servisan: -10_000, kas: -10_000 });
  await expectRefused(
    h.run('changeCancelFee', { ticketId, fee: 40_000, reason: 'Sama' }, h.ownerId),
    'repair.refusal.nothingChanged',
  );
  await expectBalancedBooks(h);
});

test('a manager cuts a charged bill only within the refund limit, as Kurangi tagihan', async () => {
  const { h, ticketId } = await chargedCancel(898);
  // 70 000 to 0 takes 70 000 off the bill: beyond the manager's refund limit.
  await expectRefused(
    h.run('changeCancelFee', { ticketId, fee: 0, reason: 'Gratis' }, h.managerId),
    'money.refusal.overLimit',
  );
  await h.run('changeCancelFee', { ticketId, fee: 50_000, reason: 'Kenal' }, h.managerId);
  expect(await bothSides(h, ticketId)).toEqual({ servisan: 0, kas: 0 });
});

test('a fee op alone never puts a charged fee below its charge', async () => {
  // The server judges each op alone, so a forged client could send the fee without its cut: a
  // charged fee only ever rises; the bill comes down through money's own cut.
  const { h, ticketId } = await chargedCancel(899);
  const cancel = (await h.ownOps()).find((op) => op.type === 'repair.ticket_cancelled')!;
  const feeChange = (fee: number) => ({
    ...cancel,
    id: `${cancel.id.slice(0, -4)}ffff`,
    type: 'repair.cancel_fee_changed',
    schemaVersion: 1,
    payload: { fee, reason: 'Gratis' },
    userId: h.managerId,
    timestamp: h.now(),
  });
  await expectRefused(h.checkRule(feeChange(0)), 'repair.refusal.feeBelowCharged');
  await expectRefused(h.checkRule(feeChange(50_000)), 'repair.refusal.feeBelowCharged');
  await h.checkRule(feeChange(80_000));
  expect(ticketId).toBeTruthy();
});
