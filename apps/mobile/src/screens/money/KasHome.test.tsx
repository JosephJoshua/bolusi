// The Kas surface over a real runtime: the drawer's figure, Tutup kas with its difference, an
// owner settling it, cash out with a reason, and a customer paying a debt from the unpaid list.
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog, type MoneyRuntime } from '@bolusi/modules/money/screens';
import { servisanCustomers } from '@bolusi/modules/repair/screens';
import { afterEach, describe, expect, test } from 'vitest';
import { formatMoney } from '@bolusi/i18n';

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

import { FontScaleProvider } from '@bolusi/ui';

import { __windowMetrics } from '../../../test/doubles/react-native.js';
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
    approvals: repair.approvals,
    subscribe: repair.subscribe,
    nameOf: (id) => (id === harness.cashierId ? USER_NAMES.cashier : null),
    customersOf: (documents) => servisanCustomers(repair, documents),
  };
}

function kasHome(harness: RepairHarness, userId: string, now: number): React.JSX.Element {
  return (
    <FontScaleProvider>
      <KasHome
        runtime={moneyRuntimeFor(harness, userId)}
        now={() => now}
        syncChip={null}
        avatar={null}
      />
    </FontScaleProvider>
  );
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
  const screen = render(kasHome(harness, userId, now));
  await settle();
  return screen;
}

/**
 * What should be in the drawer, as the book says. The counter counts blind and is not shown it
 * (Joseph, 2026-10-31), so tests that run as the counter read it from the book.
 */
async function drawerFigure(harness: RepairHarness): Promise<string> {
  const { rows } = await harness.moneyQuery('cashDrawer', {}, harness.storeOwnerId);
  return formatMoney((rows[0] as { expected: number }).expected);
}

/** Change money put in, so the drawer holds something to count. */
async function float(harness: RepairHarness, amount: number): Promise<void> {
  await harness.money('moveCash', { kind: 'float', amount, reason: 'Modal' }, harness.cashierId);
}

describe('the drawer', () => {
  test('the counter counts blind, checks it, may count once more, and the owner gets the difference', async () => {
    h = await openRepairScreenHarness(5401);
    await float(h, 100_000);
    const screen = await mount(h, h.cashierId);
    // Neither Kas nor the count shows the counter what should be in the drawer.
    expect(screen.query('money.kas.expected')).toBeNull();
    expect(text(screen, 'money.kas.lastCount')).toBe('Belum tutup kas hari ini');

    await press(screen, 'money.kas.count');
    expect(screen.query('money.count.expected')).toBeNull();
    type(screen, 'money.count.counted', '95000');
    await settle();
    expect(screen.query('money.count.difference')).toBeNull();
    expect(text(screen, 'money.count.primary')).toContain('Cek hitungan');
    await press(screen, 'money.count.primary');
    // Checked: now it shows, and a count that is off may be counted once more, blind again.
    expect(text(screen, 'money.count.expected')).toBe('Rp 100.000');
    expect(text(screen, 'money.count.difference')).toBe('Kurang Rp 5.000');
    await press(screen, 'money.count.recount');
    expect(screen.query('money.count.expected')).toBeNull();
    type(screen, 'money.count.counted', '95000');
    await settle();
    await press(screen, 'money.count.primary');
    expect(text(screen, 'money.count.difference')).toBe('Kurang Rp 5.000');
    // Once only.
    expect(screen.query('money.count.recount')).toBeNull();
    expect(text(screen, 'money.count.primary')).toContain('Simpan hitungan');
    await press(screen, 'money.count.primary');

    expect(text(screen, 'money.kas.lastCount')).toMatch(/^Sudah tutup kas pukul/);
    // The counter sees the difference waiting, and cannot settle it.
    expect(text(screen, 'money.kas.differences')).toContain('Menunggu pemilik');
    expect(text(screen, 'money.kas.differences')).toContain('Kurang Rp 5.000');
  });

  test('an owner sees what should be in the drawer up front, and the difference as they type', async () => {
    h = await openRepairScreenHarness(5410);
    await float(h, 100_000);
    const screen = await mount(h, h.storeOwnerId);
    expect(text(screen, 'money.kas.expected')).toBe('Rp 100.000');
    await press(screen, 'money.kas.count');
    expect(text(screen, 'money.count.expected')).toBe('Rp 100.000');
    type(screen, 'money.count.counted', '95000');
    await settle();
    expect(text(screen, 'money.count.difference')).toBe('Kurang Rp 5.000');
    expect(text(screen, 'money.count.primary')).toContain('Simpan hitungan');
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

    expect(await drawerFigure(h)).toBe('Rp 80.000');
    expect(text(screen, 'money.kas.moves')).toContain('Biaya toko');
    expect(text(screen, 'money.kas.moves')).toContain('Bensin');
    expect(text(screen, 'money.kas.moves')).toContain('\u2212Rp 20.000');
  });

  test('cash out stops at what the drawer holds, for an owner', async () => {
    h = await openRepairScreenHarness(5409);
    await float(h, 700_000);
    const screen = await mount(h, h.storeOwnerId);
    await press(screen, 'money.kas.move');
    type(screen, 'money.move.amount', '900000');
    type(screen, 'money.move.reason', 'Setor ke pemilik');
    await settle();
    expect(screen.all('money.move.primary')[0]!.props['disabled']).toBe(true);
    expect(text(screen, 'money.move.primaryHint')).toContain('Rp 700.000');
    type(screen, 'money.move.amount', '700000');
    await settle();
    await press(screen, 'money.move.primary');
    expect(await drawerFigure(h)).toBe('Rp 0');
  });

  // QA: a refusal just above the drawer told a blind counter its figure, a try at a time.
  test('someone who counts blind is not stopped at the drawer, and sees no takings total', async () => {
    h = await openRepairScreenHarness(5411);
    await float(h, 700_000);
    const screen = await mount(h, h.cashierId);
    expect(screen.query('money.kas.in')).toBeNull();
    await press(screen, 'money.kas.move');
    type(screen, 'money.move.amount', '700001');
    type(screen, 'money.move.reason', 'Setor ke pemilik');
    await settle();
    expect(screen.all('money.move.primary')[0]!.props['disabled']).toBe(false);
    expect(screen.query('money.move.primaryHint')).toBeNull();
  });

  // QA: a system font size change sent the phone back to the board and dropped the open form.
  test('a system font size change keeps the open form and what is typed in it', async () => {
    h = await openRepairScreenHarness(5410);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.move');
    await press(screen, 'money.move.kind.expense');
    type(screen, 'money.move.amount', '20000');
    type(screen, 'money.move.reason', 'Bensin');
    await settle();
    // The native node itself: the test renderer's wrappers are not kept across updates.
    const firstText = (): unknown =>
      screen.container.queryAll((n) => n.type === 'Text')[0]?.unstable_fiber?.stateNode;
    const textBefore = firstText();

    try {
      __windowMetrics.fontScale = 1.3;
      screen.rerender(kasHome(h, h.cashierId, Date.now()));
      await settle();
    } finally {
      __windowMetrics.fontScale = 1;
    }

    // Every text is drawn afresh at the new size, inside the same form.
    expect(firstText()).not.toBe(textBefore);
    expect(screen.query('money.move')).not.toBeNull();
    expect(screen.get('money.move.reason.field').props['value']).toBe('Bensin');
    expect(screen.get('money.move.amount.field').props['value']).toBe('20.000');
  });

  test('a bank deposit asks for an account the store does not have yet', async () => {
    h = await openRepairScreenHarness(5404);
    await float(h, 100_000);
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

    expect(await drawerFigure(h)).toBe('Rp 40.000');
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
    // Still on the count, with what was typed.
    expect(screen.all('money.count.counted.field')[0]!.props['value']).toBe('95.000');

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
    expect(text(screen, 'money.kas.moves')).toContain('\u2212Rp 5.000');
    expect(await drawerFigure(h)).toBe('Rp 95.000');
  });
});

describe('what customers owe', () => {
  test('a phone handed over unpaid is on the list, and the counter takes the payment', async () => {
    h = await openRepairScreenHarness(5406);
    // The store also takes transfers, so the counter picks each payment's method (round 2 QA, A11).
    await h.money('saveAccount', { kind: 'transfer', name: 'BCA' }, h.storeOwnerId);
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
    expect(text(screen, 'money.receive.pay.line0.pick')).toBe('Pilih cara bayarnya dulu.');
    expect(screen.all('money.receive.primary')[0]!.props['disabled']).toBe(true);
    await press(screen, 'money.receive.pay.line0.method.cash');
    expect(screen.query('money.receive.pay.line0.pick')).toBeNull();
    // A second line names no method before one is picked (QA round B); then take it away again.
    await press(screen, 'money.receive.pay.add');
    const removes = screen.all('money.receive.pay.line0.remove');
    expect(removes[0]!.props['accessibilityLabel']).toBe('Hapus pembayaran Tunai');
    const second = screen.all('money.receive.pay.line1.remove')[0]!;
    expect(second.props['accessibilityLabel']).toBe('Hapus pembayaran ini');
    await press(screen, 'money.receive.pay.line1.remove');
    expect(screen.query('money.receive.pay.line1.remove')).toBeNull();
    // Handed over exactly: no "Kembalian Rp 0" (round 2 QA, F14); more shows the change.
    type(screen, 'money.receive.pay.line0.tendered', '500000');
    await settle();
    expect(screen.query('money.receive.pay.line0.change')).toBeNull();
    type(screen, 'money.receive.pay.line0.tendered', '600000');
    await settle();
    expect(text(screen, 'money.receive.pay.line0.change')).toBe('Rp 100.000');
    expect(text(screen, 'money.receive.primary')).toContain('Terima Rp 500.000');
    await press(screen, 'money.receive.primary');

    expect(text(screen, `money.kas.owed.${ticketId}.value`)).toBe('Rp 250.000');
    // The counter counts blind, so today's takings are not added up for them.
    expect(screen.query('money.kas.in')).toBeNull();
    expect(await drawerFigure(h)).toBe('Rp 500.000');
  });

  // Round 2 QA, F14: what went back read as a method's negative money in.
  test('money handed back today is its own line under money in, and the total is net', async () => {
    h = await openRepairScreenHarness(5408);
    const { ticketId } = (await h.run(
      'openTicket',
      intake(h, { downPayment: 200_000 }),
      h.cashierId,
    )) as {
      ticketId: string;
    };
    await h.money(
      'refund',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: 'x' },
        account: 'cash',
        amount: 50_000,
        reason: 'Batal sebagian',
      },
      h.storeOwnerId,
    );
    const screen = await mount(h, h.storeOwnerId);
    expect(text(screen, 'money.kas.in.cash.value')).toBe('Rp 200.000');
    expect(text(screen, 'money.kas.in.refunded')).toContain('Dikembalikan ke pelanggan');
    expect(text(screen, 'money.kas.in.refunded.value')).toBe('\u2212Rp 50.000');
    expect(text(screen, 'money.kas.in.total.value')).toBe('Rp 150.000');
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
    // Said once, under the payment: not again as the button's hint (round 2 QA, F14).
    expect(text(screen, 'money.receive.pay.overpaid')).toBe(
      'Lebih Rp 50.000. Kurangi jumlahnya dulu.',
    );
    expect(screen.query('money.receive.primaryHint')).toBeNull();
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
    const drawer = await drawerFigure(h);
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
    expect(await drawerFigure(h)).toBe('Rp 750.000');
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
    // Android QA (#121): where to ask instead, and the debt as it is, not as the cap would leave it.
    expect(text(screen, 'money.reduce.primaryHint')).toBe(
      'Minta persetujuan pemilik dari halaman servisan.',
    );
    expect(text(screen, 'money.reduce.after')).toContain('Rp 750.000');
    type(screen, 'money.reduce.amount', '30000');
    await settle();
    await press(screen, 'money.reduce.primary');
    expect(text(screen, `money.kas.owed.${ticketId}.value`)).toBe('Rp 720.000');
  });
});

describe('Riwayat', () => {
  async function paid(harness: RepairHarness, amount = 200_000): Promise<string> {
    const { ticketId, ticketNumber } = (await harness.run(
      'openTicket',
      intake(harness),
      harness.cashierId,
    )) as { ticketId: string; ticketNumber: string };
    await harness.money(
      'receivePayments',
      {
        document: { kind: 'repair.ticket', id: ticketId, label: ticketNumber },
        payments: [{ account: 'cash', amount }],
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
    expect(text(screen, row)).toContain('Pembayaran dibatalkan');
    expect(text(screen, row)).toContain('Salah metode');
    await press(screen, 'money.history.back');
    expect(text(screen, 'money.kas.expected')).toBe('Rp 0');
  });

  /** The waiting requests `userId` may answer or asked. */
  async function waiting(harness: RepairHarness, userId: string) {
    return (await harness.approvalsQuery('approvalRequests', {}, userId)).rows;
  }

  test('a manager beyond their cancel limit asks an owner, whose yes cancels the payment', async () => {
    h = await openRepairScreenHarness(5415);
    const entryId = await paid(h);
    const screen = await mount(h, h.managerId);
    await press(screen, 'money.kas.history');
    await press(screen, `money.history.entry.${entryId}`);
    // The manager's refund limit in the harness, which voids count against too.
    expect(text(screen, 'money.void.limit')).toBe('Batas pembatalanmu Rp 30.000 per servisan.');
    // Rp 200.000 is beyond it: said before any reason is typed, and it goes to an owner.
    await settle();
    expect(text(screen, 'money.void.asks')).toBe('Melebihi batasmu, jadi perlu persetujuan.');
    expect(text(screen, 'money.void.primary')).toBe('Minta persetujuan');
    type(screen, 'money.void.reason', 'Salah metode');
    await settle();
    await press(screen, 'money.void.primary');
    expect(text(screen, 'money.history.notice')).toBe(
      'Permintaan dibuat. Pemilik toko akan memutuskan.',
    );
    const [request] = await waiting(h, h.storeOwnerId);
    expect(request).toMatchObject({ kind: 'money.voidPayment', amount: 200_000 });
    await h.approvals('approveRequest', { requestId: request!.id }, h.storeOwnerId);
    const entry = await h.db
      .selectFrom('moneyEntries')
      .select(['voidedBy', 'voidReason'])
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ voidedBy: h.storeOwnerId, voidReason: 'Salah metode' });
  });

  test('a manager’s limit counts what was already taken off the servisan, and says so', async () => {
    h = await openRepairScreenHarness(5416);
    const entryId = await paid(h);
    const ticket = await h.db
      .selectFrom('moneyEntries')
      .select(['documentId', 'documentLabel'])
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    const document = {
      kind: 'repair.ticket',
      id: ticket.documentId!,
      label: ticket.documentLabel!,
    };
    const pay = async (amount: number) => {
      await h!.money(
        'receivePayments',
        { document, payments: [{ account: 'cash', amount }] },
        h!.cashierId,
      );
      return (
        await h!.db
          .selectFrom('moneyEntries')
          .select('id')
          .where('kind', '=', 'payment_received')
          .where('amount', '=', amount)
          .executeTakeFirstOrThrow()
      ).id!;
    };
    const first = await pay(15_000);
    const second = await pay(20_000);
    // Rp 15.000 cancelled already: Rp 20.000 more is Rp 35.000, beyond the manager's Rp 30.000.
    await h.money('voidPayment', { entryId: first, reason: 'Salah metode' }, h.storeOwnerId);
    const screen = await mount(h, h.managerId);
    await press(screen, 'money.kas.history');
    await press(screen, `money.history.entry.${second}`);
    await settle();
    expect(text(screen, 'money.void.withEarlier')).toMatch(
      /^Bersama pengurangan sebelumnya di servisan ini, totalnya Rp\s?35\.000\.$/,
    );
    expect(text(screen, 'money.void.primary')).toBe('Minta persetujuan');
  });

  test('the counter hears on Kas when an owner turns a cancel down, and may ask again', async () => {
    h = await openRepairScreenHarness(5417);
    const entryId = await paid(h);
    const ticket = await h.db
      .selectFrom('moneyEntries')
      .select(['documentId'])
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    const requestId = (
      (await h.approvals(
        'requestApproval',
        {
          kind: 'money.voidPayment',
          input: {
            entryId,
            reason: 'Tercatat dua kali',
            document: { kind: 'repair.ticket', id: ticket.documentId! },
          },
          reason: 'Tercatat dua kali',
        },
        h.cashierId,
      )) as { requestId: string }
    ).requestId;
    await h.approvals('rejectRequest', { requestId, note: 'Uangnya ada' }, h.storeOwnerId);
    const screen = await mount(h, h.cashierId);
    // Told on the board, with who said no and why.
    expect(text(screen, `money.kas.turnedDown.${requestId}`)).toContain(USER_NAMES.storeOwner);
    expect(text(screen, `money.kas.turnedDown.${requestId}`)).toContain('Uangnya ada');
    await press(screen, `money.kas.turnedDown.${requestId}`);
    // In Riwayat the payment says so too, and can be asked about again.
    expect(text(screen, `money.history.entry.${entryId}`)).toContain('Ditolak oleh');
    await press(screen, `money.history.entry.${entryId}`);
    // The cancel step names the customer, not only the servisan number.
    expect(text(screen, 'money.void')).toContain('Yohanis Wenda');
    expect(text(screen, 'money.void.primary')).toBe('Minta persetujuan');
  });

  test('the counter cannot cancel a payment, only ask an owner to', async () => {
    h = await openRepairScreenHarness(5413);
    const entryId = await paid(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'money.kas.history');
    await press(screen, `money.history.entry.${entryId}`);
    await settle();
    expect(screen.query('money.void.limit')).toBeNull();
    expect(text(screen, 'money.void.asks')).toBe('Perlu persetujuan pemilik toko.');
    type(screen, 'money.void.reason', 'Tercatat dua kali');
    await settle();
    await press(screen, 'money.void.primary');
    const [request] = await waiting(h, h.storeOwnerId);
    expect(request).toMatchObject({ kind: 'money.voidPayment', reason: 'Tercatat dua kali' });
    // Back in Riwayat the payment says it waits, and is not asked about twice.
    await settle();
    expect(text(screen, `money.history.entry.${entryId}`)).toContain('Menunggu persetujuan');
    await expect(press(screen, `money.history.entry.${entryId}`)).rejects.toThrow(/no onPress/);
    // Once the owner answers, "an owner was asked" goes rather than sit above the answer.
    expect(screen.query('money.history.notice')).not.toBeNull();
    await h.approvals('rejectRequest', { requestId: request!.id }, h.storeOwnerId);
    await settle();
    expect(screen.query('money.history.notice')).toBeNull();
    expect(text(screen, `money.history.entry.${entryId}`)).toContain('Ditolak oleh');
    // Nothing is cancelled until an owner says yes.
    const entry = await h.db
      .selectFrom('moneyEntries')
      .select('voidedBy')
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    expect(entry.voidedBy).toBeNull();
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
