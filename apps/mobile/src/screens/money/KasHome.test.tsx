// The Kas surface over a real runtime: the drawer's figure, Tutup kas with its difference, an
// owner settling it, cash out with a reason, and a customer paying a debt from the unpaid list.
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog, type MoneyRuntime } from '@bolusi/modules/money/screens';
import { servisanCustomers } from '@bolusi/modules/repair/screens';
import { afterEach, describe, expect, test } from 'vitest';

import {
  accessoriesBack,
  ensureRepairCatalog,
  intake,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  text,
  type,
  USER_NAMES,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import { KasHome } from './KasHome.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Kas as `userId` sees it, live on the same runtime the repair screens use. */
function moneyRuntimeFor(harness: RepairHarness, userId: string): MoneyRuntime {
  const repair = repairRuntimeFor(harness, userId);
  return {
    ...repair.money,
    subscribe: repair.subscribe,
    nameOf: (id) => (id === harness.cashierId ? USER_NAMES.cashier : null),
    customersOf: (documents) => servisanCustomers(repair, documents),
  };
}

async function mount(harness: RepairHarness, userId: string): Promise<RenderResult> {
  ensureRepairCatalog();
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  // The board's "today" is the harness clock's day: every op it writes lands on it.
  const latest = await harness.db
    .selectFrom('moneyEntries')
    .select('createdAt')
    .orderBy('createdAt', 'desc')
    .executeTakeFirst();
  const now = latest === undefined ? Date.now() : Number(latest.createdAt);
  const screen = render(
    <KasHome
      runtime={moneyRuntimeFor(harness, userId)}
      now={() => now}
      syncChip={null}
      avatar={null}
    />,
  );
  await settle();
  return screen;
}

/** Change money put in, so the drawer holds something to count. */
async function float(harness: RepairHarness, amount: number): Promise<void> {
  await harness.money('moveCash', { kind: 'float', amount, reason: 'Modal' }, harness.cashierId);
}

describe('the drawer', () => {
  test('Tutup kas shows the difference before it is saved, and keeps it for an owner', async () => {
    h = await openRepairScreenHarness(5401);
    await float(h, 100_000);
    const screen = await mount(h, h.cashierId);
    expect(text(screen, 'money.kas.expected')).toBe('Rp 100.000');
    expect(text(screen, 'money.kas.lastCount')).toBe('Belum tutup kas hari ini');

    await press(screen, 'money.kas.count');
    expect(text(screen, 'money.count.expected')).toBe('Rp 100.000');
    type(screen, 'money.count.counted', '95000');
    await settle();
    expect(text(screen, 'money.count.difference')).toBe('Kurang Rp 5.000');
    await press(screen, 'money.count.primary');

    expect(text(screen, 'money.kas.lastCount')).toMatch(/^Sudah tutup kas pukul/);
    // The counter sees the difference waiting, and cannot settle it.
    expect(text(screen, 'money.kas.differences')).toContain('Menunggu pemilik');
    expect(text(screen, 'money.kas.differences')).toContain('Kurang Rp 5.000');
  });

  test('an owner settles a difference with a reason, and the book matches the drawer', async () => {
    h = await openRepairScreenHarness(5402);
    await float(h, 100_000);
    await h.money('countCash', { counted: 95_000 }, h.cashierId);
    const screen = await mount(h, h.storeOwnerId);
    expect(text(screen, 'money.kas.differences')).toContain(USER_NAMES.cashier);

    const countId = (
      (await h.moneyQuery('cashDrawer', {}, h.storeOwnerId)).rows[0] as {
        counts: { id: string }[];
      }
    ).counts[0]!.id;
    await press(screen, `money.kas.difference.${countId}`);
    expect(text(screen, 'money.settle.difference')).toBe('Kurang Rp 5.000');
    expect(screen.all('money.settle.primary')[0]!.props['disabled']).toBe(true);
    type(screen, 'money.settle.reason', 'Salah kembalian');
    await settle();
    await press(screen, 'money.settle.primary');

    expect(screen.query('money.kas.differences')).toBeNull();
    expect(text(screen, 'money.kas.expected')).toBe('Rp 95.000');
  });

  test('a newer count while the owner reads closes the settle step to the older difference', async () => {
    h = await openRepairScreenHarness(5409);
    await float(h, 100_000);
    await h.money('countCash', { counted: 95_000 }, h.cashierId);
    const screen = await mount(h, h.storeOwnerId);
    const countId = (
      (await h.moneyQuery('cashDrawer', {}, h.storeOwnerId)).rows[0] as {
        counts: { id: string }[];
      }
    ).counts[0]!.id;
    await press(screen, `money.kas.difference.${countId}`);
    type(screen, 'money.settle.reason', 'Salah kembalian');
    await settle();
    expect(screen.all('money.settle.primary')[0]!.props['disabled']).toBe(false);

    await h.money('countCash', { counted: 95_000 }, h.cashierId);
    await settle();
    expect(screen.all('money.settle.primary')[0]!.props['disabled']).toBe(true);
    expect(text(screen, 'money.settle.primaryHint')).toBe(
      'Selisih ini sudah diselesaikan atau ada hitungan yang lebih baru.',
    );
  });

  test('cash out of the drawer needs a reason, and shows with today’s moves', async () => {
    h = await openRepairScreenHarness(5403);
    await float(h, 100_000);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.move');
    await press(screen, 'money.move.kind.expense');
    type(screen, 'money.move.amount', '20000');
    await settle();
    expect(text(screen, 'money.move.primaryHint')).toBe('Isi keterangannya.');
    type(screen, 'money.move.reason', 'Bensin');
    await settle();
    await press(screen, 'money.move.primary');

    expect(text(screen, 'money.kas.expected')).toBe('Rp 80.000');
    expect(text(screen, 'money.kas.moves')).toContain('Biaya toko');
    expect(text(screen, 'money.kas.moves')).toContain('Bensin');
    expect(text(screen, 'money.kas.moves')).toContain('−Rp 20.000');
  });

  test('a bank deposit asks for an account the store does not have yet', async () => {
    h = await openRepairScreenHarness(5404);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.move');
    await press(screen, 'money.move.kind.deposit');
    type(screen, 'money.move.amount', '20000');
    type(screen, 'money.move.reason', 'Setor BRI');
    await settle();
    expect(text(screen, 'money.move.primaryHint')).toBe(
      'Belum ada rekening toko. Minta pemilik menambahkannya.',
    );
  });

  test('a bank deposit goes into the store’s bank account, not its QRIS', async () => {
    h = await openRepairScreenHarness(5408);
    await float(h, 100_000);
    await h.money('saveAccount', { kind: 'qris', name: 'QRIS BCA' }, h.storeOwnerId);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'transfer', name: 'BRI toko' },
      h.storeOwnerId,
    )) as { accountId: string };
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.move');
    await press(screen, 'money.move.kind.deposit');
    // One bank account: nothing to choose.
    expect(screen.query('money.move.accounts')).toBeNull();
    type(screen, 'money.move.amount', '60000');
    type(screen, 'money.move.reason', 'Setor BRI');
    await settle();
    await press(screen, 'money.move.primary');

    expect(text(screen, 'money.kas.expected')).toBe('Rp 40.000');
    const deposit = await h.db
      .selectFrom('moneyEntries')
      .select(['account', 'amount'])
      .where('subKind', '=', 'deposit')
      .executeTakeFirstOrThrow();
    expect(deposit).toEqual({ account: `account:${accountId}`, amount: 60_000 });
  });

  test('back in a step returns to the board, where Kas has no back of its own', async () => {
    h = await openRepairScreenHarness(5405);
    let nav: { handleBack: () => boolean } | null = null;
    ensureRepairCatalog();
    registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
    const screen = render(
      <KasHome
        runtime={moneyRuntimeFor(h, h.cashierId)}
        now={() => Date.now()}
        syncChip={null}
        avatar={null}
        onRegisterSurfaceNav={(next) => {
          nav = next;
        }}
      />,
    );
    await settle();
    expect(nav).toBeNull();
    await press(screen, 'money.kas.count');
    expect(screen.query('money.count')).not.toBeNull();
    expect(nav!.handleBack()).toBe(true);
    await settle();
    expect(screen.query('money.count')).toBeNull();
    expect(nav).toBeNull();
  });
  test('back from a half-typed count asks before dropping it', async () => {
    h = await openRepairScreenHarness(5410);
    let nav: { handleBack: () => boolean } | null = null;
    ensureRepairCatalog();
    registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
    const screen = render(
      <KasHome
        runtime={moneyRuntimeFor(h, h.cashierId)}
        now={() => Date.now()}
        syncChip={null}
        avatar={null}
        onRegisterSurfaceNav={(next) => {
          nav = next;
        }}
      />,
    );
    await settle();
    await press(screen, 'money.kas.count');
    type(screen, 'money.count.counted', '95000');
    await settle();

    expect(nav!.handleBack()).toBe(true);
    await settle();
    expect(screen.query('money.count.discard')).not.toBeNull();
    await press(screen, 'money.count.discard.cancel');
    expect(text(screen, 'money.count.difference')).toBe('Lebih Rp 95.000');

    await press(screen, 'money.count.back');
    await press(screen, 'money.count.discard.confirm');
    expect(screen.query('money.count')).toBeNull();
    expect(screen.query('money.kas')).not.toBeNull();
  });

  test('an owner’s correction shows with today’s moves, so they explain the drawer', async () => {
    h = await openRepairScreenHarness(5411);
    await float(h, 100_000);
    const { entryId: countId } = (await h.money('countCash', { counted: 95_000 }, h.cashierId)) as {
      entryId: string;
    };
    await h.money(
      'adjustCash',
      { amount: -5_000, countId, reason: 'Salah kembalian' },
      h.storeOwnerId,
    );
    const screen = await mount(h, h.cashierId);
    expect(text(screen, 'money.kas.moves')).toContain('Selisih kas diselesaikan');
    expect(text(screen, 'money.kas.moves')).toContain('Salah kembalian');
    expect(text(screen, 'money.kas.moves')).toContain('−Rp 5.000');
    expect(text(screen, 'money.kas.expected')).toBe('Rp 95.000');
  });
});

describe('what customers owe', () => {
  test('a phone handed over unpaid is on the list, and the counter takes the payment', async () => {
    h = await openRepairScreenHarness(5406);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: h.photo(7),
        signature: h.photo(8),
        payments: [],
        unpaidReason: 'Bayar Jumat',
        checklist: accessoriesBack(),
      },
      h.ownerId,
    );
    const screen = await mount(h, h.cashierId);
    const owed = text(screen, `money.kas.owed.${ticketId}.value`);
    expect(owed).toBe('Rp 750.000');
    // The customer, not only the servisan number, is who the counter looks for.
    expect(text(screen, `money.kas.owed.${ticketId}`)).toMatch(/^Yohanis Wenda.*-\d{4}/);

    await press(screen, `money.kas.owed.${ticketId}`);
    expect(text(screen, 'money.receive.owed')).toBe('Rp 750.000');
    expect(text(screen, 'money.receive')).toContain('Yohanis Wenda');
    // Part of it today.
    type(screen, 'money.receive.pay.line0.amount', '500000');
    await settle();
    expect(text(screen, 'money.receive.primary')).toContain('Terima Rp 500.000');
    await press(screen, 'money.receive.primary');

    expect(text(screen, `money.kas.owed.${ticketId}.value`)).toBe('Rp 250.000');
    expect(text(screen, 'money.kas.in.cash.value')).toBe('Rp 500.000');
  });

  test('more than what is owed cannot be taken', async () => {
    h = await openRepairScreenHarness(5407);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: h.photo(7),
        signature: h.photo(8),
        payments: [],
        unpaidReason: 'Bayar Jumat',
        checklist: accessoriesBack(),
      },
      h.ownerId,
    );
    const screen = await mount(h, h.cashierId);
    await press(screen, `money.kas.owed.${ticketId}`);
    type(screen, 'money.receive.pay.line0.amount', '800000');
    await settle();
    expect(screen.all('money.receive.primary')[0]!.props['disabled']).toBe(true);
  });
});

describe('money back and lowered bills', () => {
  async function handedOver(
    harness: RepairHarness,
    payments: readonly { account: string; amount: number }[],
  ): Promise<string> {
    const { ticketId } = (await harness.run('openTicket', intake(harness), harness.cashierId)) as {
      ticketId: string;
    };
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
    await harness.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: harness.photo(7),
        signature: harness.photo(8),
        payments: [...payments],
        ...(payments.length === 0 ? { unpaidReason: 'Bayar Jumat' } : {}),
        checklist: accessoriesBack(),
      },
      harness.ownerId,
    );
    return ticketId;
  }

  test('the counter gives back a bill paid twice, through the drawer it came into', async () => {
    h = await openRepairScreenHarness(5410);
    const ticketId = await handedOver(h, [{ account: 'cash', amount: 750_000 }]);
    // A second counter, offline, took part of the same bill again.
    await h.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        payments: [{ account: 'cash', amount: 100_000 }],
      },
      h.cashierId,
    );
    const screen = await mount(h, h.cashierId);
    expect(text(screen, `money.kas.owedBack.${ticketId}.value`)).toBe('Rp 100.000');
    const drawer = text(screen, 'money.kas.expected');
    expect(drawer).toBe('Rp 850.000');

    await press(screen, `money.kas.owedBack.${ticketId}`);
    expect(text(screen, 'money.refund.credit')).toContain('Rp 100.000');
    // What was paid in all is the owner's to see and give back.
    expect(screen.all('money.refund.paid')).toEqual([]);
    expect(text(screen, 'money.refund.primary')).toContain('Kembalikan Rp 100.000');
    expect(screen.all('money.refund.primary')[0]!.props['disabled']).toBe(true);
    type(screen, 'money.refund.amount', '150000');
    await settle();
    expect(text(screen, 'money.refund')).toContain('Paling banyak Rp 100.000');
    type(screen, 'money.refund.amount', '100000');
    type(screen, 'money.refund.reason', 'Bayar dua kali');
    await settle();
    await press(screen, 'money.refund.primary');

    expect(screen.all(`money.kas.owedBack.${ticketId}`)).toEqual([]);
    expect(text(screen, 'money.kas.expected')).toBe('Rp 750.000');
  });

  test('an owner lowers a debt from taking its payment', async () => {
    h = await openRepairScreenHarness(5411);
    const ticketId = await handedOver(h, []);
    const counter = await mount(h, h.cashierId);
    await press(counter, `money.kas.owed.${ticketId}`);
    expect(counter.all('money.receive.reduce')).toEqual([]);
    counter.unmount();

    const screen = await mount(h, h.ownerId);
    await press(screen, `money.kas.owed.${ticketId}`);
    // A payment half typed is not dropped without asking.
    type(screen, 'money.receive.pay.line0.amount', '300000');
    await settle();
    await press(screen, 'money.receive.reduce');
    expect(screen.query('money.receive.discard')).not.toBeNull();
    await press(screen, 'money.receive.discard.confirm');
    expect(text(screen, 'money.reduce.owed')).toContain('Rp 750.000');
    type(screen, 'money.reduce.amount', '100000');
    await settle();
    expect(text(screen, 'money.reduce.after')).toContain('Rp 650.000');
    expect(screen.all('money.reduce.primary')[0]!.props['disabled']).toBe(true);
    type(screen, 'money.reduce.reason', 'Pelanggan lama');
    await settle();
    await press(screen, 'money.reduce.primary');

    expect(text(screen, `money.kas.owed.${ticketId}.value`)).toBe('Rp 650.000');
  });

  // Android QA (#90): a manager over their limit only learned it when the save was refused.
  test('a manager sees their limit and cannot take more off a bill than it allows', async () => {
    h = await openRepairScreenHarness(5413);
    const ticketId = await handedOver(h, []);
    const screen = await mount(h, h.managerId);
    await press(screen, `money.kas.owed.${ticketId}`);
    await press(screen, 'money.receive.reduce');
    expect(text(screen, 'money.reduce.limit')).toContain('Rp 30.000');
    type(screen, 'money.reduce.amount', '40000');
    type(screen, 'money.reduce.reason', 'Pelanggan lama');
    await settle();
    expect(text(screen, 'money.reduce')).toContain('Melebihi batasmu. Paling banyak Rp 30.000.');
    expect(screen.all('money.reduce.primary')[0]!.props['disabled']).toBe(true);
    type(screen, 'money.reduce.amount', '30000');
    await settle();
    await press(screen, 'money.reduce.primary');
    expect(text(screen, `money.kas.owed.${ticketId}.value`)).toBe('Rp 720.000');
  });
});

describe('Riwayat', () => {
  async function paid(harness: RepairHarness): Promise<string> {
    const { ticketId, ticketNumber } = (await harness.run(
      'openTicket',
      intake(harness),
      harness.cashierId,
    )) as { ticketId: string; ticketNumber: string };
    await harness.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: ticketNumber },
        payments: [{ account: 'cash', amount: 200_000 }],
      },
      harness.cashierId,
    );
    const row = await harness.db
      .selectFrom('moneyEntries')
      .select('id')
      .where('kind', '=', 'payment_received')
      .executeTakeFirstOrThrow();
    return row.id!;
  }

  test('an owner cancels a wrong payment with a reason; it stays, struck through', async () => {
    h = await openRepairScreenHarness(5412);
    const entryId = await paid(h);
    const screen = await mount(h, h.storeOwnerId);
    expect(text(screen, 'money.kas.expected')).toBe('Rp 200.000');

    await press(screen, 'money.kas.history');
    expect(text(screen, 'money.history.day')).toBe('Hari ini');
    expect(screen.all('money.history.next')[0]!.props['disabled']).toBe(true);
    const row = `money.history.entry.${entryId}`;
    expect(text(screen, row)).toContain('Pembayaran diterima');
    expect(text(screen, row)).toContain('Yohanis Wenda');
    expect(text(screen, row)).toContain('Tunai');

    await press(screen, row);
    expect(text(screen, 'money.void.amount')).toBe('Rp 200.000');
    expect(screen.query('money.void.limit')).toBeNull();
    expect(screen.all('money.void.primary')[0]!.props['disabled']).toBe(true);
    type(screen, 'money.void.reason', 'Salah metode');
    await settle();
    await press(screen, 'money.void.primary');

    // Back on the day's records: the payment is still there, cancelled, and no longer pressable.
    expect(text(screen, row)).toContain('Dibatalkan: Salah metode');
    await press(screen, 'money.history.back');
    expect(text(screen, 'money.kas.expected')).toBe('Rp 0');
  });

  test('a manager sees their cancel limit before cancelling a payment', async () => {
    h = await openRepairScreenHarness(5415);
    const entryId = await paid(h);
    const screen = await mount(h, h.managerId);
    await press(screen, 'money.kas.history');
    await press(screen, `money.history.entry.${entryId}`);
    // The manager's refund limit in the harness, which voids count against too.
    expect(text(screen, 'money.void.limit')).toBe('Batas pembatalanmu Rp 30.000 per servisan.');
    // Rp 200.000 is beyond it: refused before any reason is typed, not after submitting.
    type(screen, 'money.void.reason', 'Salah metode');
    await settle();
    expect(screen.all('money.void.primary')[0]!.props['disabled']).toBe(true);
    expect(text(screen, 'money.void.primaryHint')).toBe('Melebihi batasmu. Minta pemilik toko.');
  });

  test('the counter reads the records but cannot cancel one', async () => {
    h = await openRepairScreenHarness(5413);
    const entryId = await paid(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.history');
    const row = screen.all(`money.history.entry.${entryId}`)[0]!;
    expect(row.props['onPress']).toBeUndefined();
  });

  test('the day before is its own page', async () => {
    h = await openRepairScreenHarness(5414);
    await paid(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.history');
    await press(screen, 'money.history.previous');
    expect(text(screen, 'money.history.day')).not.toBe('Hari ini');
    expect(screen.query('money.history.empty')).not.toBeNull();
    await press(screen, 'money.history.next');
    expect(text(screen, 'money.history.day')).toBe('Hari ini');
    expect(screen.query('money.history.empty')).toBeNull();
  });
});
