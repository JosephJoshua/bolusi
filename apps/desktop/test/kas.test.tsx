// Kas on the PC over the demo ledger: the drawer and Tutup kas, cash out, an owner settling a
// difference, a customer paying a debt, Riwayat with an owner's cancel, and the payment methods in
// Settings. The rules are the module's; these check the PC asks for and shows the right things.
import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals/desktop';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forgetShownQrs } from '@bolusi/modules/money';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/renderer/App.js';

beforeEach(() => {
  // The demo's payments are a few hours old, so "today" must not have just begun: run at noon.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(noon);
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Each test opens fresh demo data: QRs shown in one are not the next one's.
  forgetShownQrs();
});

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);
/** An element's text without spaces: amounts print "Rp" and the figure apart. */
const text = (id: string): string => byTestId(id).textContent!.replace(/\s/g, '');

async function openKas(as?: string): Promise<void> {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
  await screen.findByTestId('repair.desk.board');
  if (as !== undefined) await switchTo(as);
  fireEvent.click(await screen.findByRole('button', { name: 'Kas' }));
  await screen.findByTestId('money.desk.kas.drawer');
}

async function switchTo(name: string): Promise<void> {
  fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await screen.findByTestId('repair.desk.board');
}

async function countDrawer(amount: string): Promise<void> {
  fireEvent.click(byTestId('money.desk.kas.count'));
  await screen.findByTestId('money.desk.count');
  fireEvent.change(byTestId('money.desk.count.counted'), { target: { value: amount } });
  fireEvent.click(byTestId('money.desk.count.submit'));
  await waitFor(() => expect(screen.queryByTestId('money.desk.count')).toBeNull());
}

describe('Kas on the PC', () => {
  it('is in the sidebar for the counter, not for a technician', async () => {
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    );
    await screen.findByTestId('repair.desk.board');
    expect(screen.getByRole('button', { name: 'Kas' })).toBeTruthy();
    await switchTo('Budi Santoso');
    expect(screen.queryByRole('button', { name: 'Kas' })).toBeNull();
  });

  it('counts the drawer, showing the difference before it is saved', async () => {
    await openKas();
    const expected = byTestId('money.desk.kas.expected').textContent!;
    fireEvent.click(byTestId('money.desk.kas.count'));
    await screen.findByTestId('money.desk.count');
    expect(byTestId('money.desk.count.submit')).toHaveProperty('disabled', true);
    expect(byTestId('money.desk.count.expected').textContent).toBe(expected);
    const drawer = Number(expected.replace(/\D/g, ''));
    fireEvent.change(byTestId('money.desk.count.counted'), {
      target: { value: String(drawer - 5_000) },
    });
    expect(text('money.desk.count.difference')).toBe('KurangRp5.000');
    fireEvent.click(byTestId('money.desk.count.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.count')).toBeNull());
    expect(byTestId('money.desk.kas.lastCount').textContent).toMatch(/^Sudah tutup kas pukul/);
    // The counter cannot settle it: an owner does.
    expect(byTestId('money.desk.kas.differences').textContent).toContain('Menunggu pemilik');
    expect(screen.queryByTestId('money.desk.kas.settle')).toBeNull();
  });

  it('lets an owner settle a counted difference with a reason', async () => {
    await openKas('Andi Pratama');
    const drawer = Number(byTestId('money.desk.kas.expected').textContent!.replace(/\D/g, ''));
    await countDrawer(String(drawer + 2_000));
    fireEvent.click(await screen.findByTestId('money.desk.kas.settle'));
    await screen.findByTestId('money.desk.settle');
    expect(text('money.desk.settle.difference')).toBe('LebihRp2.000');
    expect(byTestId('money.desk.settle.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.settle.reason'), { target: { value: 'Uang receh' } });
    fireEvent.click(byTestId('money.desk.settle.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.kas.differences')).toBeNull());
    expect(byTestId('money.desk.kas.moves').textContent).toContain('Selisih kas diselesaikan');
  });

  it('takes cash out of the drawer only with a reason', async () => {
    await openKas();
    fireEvent.click(byTestId('money.desk.kas.move'));
    await screen.findByTestId('money.desk.move');
    fireEvent.click(byTestId('money.desk.move.kind.expense'));
    fireEvent.change(byTestId('money.desk.move.amount'), { target: { value: '25000' } });
    expect(byTestId('money.desk.move.hint').textContent).toBe('Isi keterangannya.');
    expect(byTestId('money.desk.move.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.move.reason'), { target: { value: 'Beli lakban' } });
    fireEvent.click(byTestId('money.desk.move.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.move')).toBeNull());
    const move = within(byTestId('money.desk.kas.moves'))
      .getByText(/Beli lakban/)
      .closest('[data-testid^="money.desk.kas.moves."]')!;
    expect(move.textContent!.replace(/\s/g, '')).toMatch(/^Biayatoko.*Belilakban-Rp25\.000$/);
  });

  it('takes a debt paid later, then an owner cancels it in Riwayat and the debt is back', async () => {
    await openKas('Andi Pratama');
    const owed = await screen.findByTestId('money.desk.kas.owed.t-9');
    const inBefore = Number(text('money.desk.kas.in.total.value').replace(/\D/g, ''));
    expect(owed.textContent).toContain('Yulianus Wenda');
    expect(owed.textContent).toContain('K7Q-0004');
    fireEvent.click(byTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    expect(text('money.desk.receive.owed')).toBe('Rp450.000');
    // Part of it is fine; more than is owed is not.
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '500000' },
    });
    expect(byTestId('money.desk.receive.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '200000' },
    });
    fireEvent.click(byTestId('money.desk.receive.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.receive')).toBeNull());
    await waitFor(() => expect(text('money.desk.kas.owed.t-9.value')).toBe('Rp250.000'));
    expect(Number(text('money.desk.kas.in.total.value').replace(/\D/g, ''))).toBe(
      inBefore + 200_000,
    );

    fireEvent.mouseDown(byTestId('money.desk.kas.tabs.history'), { button: 0 });
    fireEvent.click(byTestId('money.desk.kas.tabs.history'));
    const table = await screen.findByTestId('money.desk.history.table');
    // Newest first: the payment just taken.
    const [voidButton] = await within(table).findAllByRole('button', {
      name: /^Batalkan pembayaran Rp\s?200\.000 pukul/,
    });
    fireEvent.click(voidButton!);
    await screen.findByTestId('money.desk.void');
    expect(text('money.desk.void.amount')).toBe('Rp200.000');
    // An owner has no limit to show.
    expect(screen.queryByTestId('money.desk.void.limit')).toBeNull();
    fireEvent.change(byTestId('money.desk.void.reason'), { target: { value: 'Salah metode' } });
    fireEvent.click(byTestId('money.desk.void.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.void')).toBeNull());
    // The record stays, with whose and which method it was and why it was cancelled.
    await waitFor(() => expect(table.textContent).toContain('Dibatalkan: Salah metode'));
    expect(table.textContent).toContain('Yulianus Wenda · K7Q-0004 · Tunai');
    expect(
      within(table).queryByRole('button', { name: /^Batalkan pembayaran Rp\s?200\.000/ }),
    ).toBeNull();

    fireEvent.mouseDown(byTestId('money.desk.kas.tabs.today'), { button: 0 });
    fireEvent.click(byTestId('money.desk.kas.tabs.today'));
    await waitFor(() => expect(text('money.desk.kas.owed.t-9.value')).toBe('Rp450.000'));
  });

  it('offers lowering a debt to owners only', async () => {
    await openKas();
    fireEvent.click(await screen.findByTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    expect(screen.queryByTestId('money.desk.receive.reduce')).toBeNull();
  });

  it('lets an owner lower a debt past what is left, then give back what is owed back', async () => {
    await openKas('Andi Pratama');
    fireEvent.click(await screen.findByTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '200000' },
    });
    fireEvent.click(byTestId('money.desk.receive.submit'));
    await waitFor(() => expect(text('money.desk.kas.owed.t-9.value')).toBe('Rp250.000'));

    // Lowered over the payment it was about to take, which waits underneath if left.
    fireEvent.click(byTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    fireEvent.click(byTestId('money.desk.receive.reduce'));
    await screen.findByTestId('money.desk.reduce');
    // The whole debt is filled in; the bill comes down at most by what was charged.
    expect(byTestId('money.desk.reduce.amount')).toHaveProperty('value', '250.000');
    expect(text('money.desk.reduce.after')).toBe('Rp0');
    fireEvent.change(byTestId('money.desk.reduce.amount'), { target: { value: '500000' } });
    expect(text('money.desk.reduce')).toContain('PalingbanyakRp450.000');
    expect(screen.queryByTestId('money.desk.reduce.hint')).toBeNull();
    expect(byTestId('money.desk.reduce.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.reduce.amount'), { target: { value: '300000' } });
    expect(byTestId('money.desk.reduce.becomesCredit').textContent).toContain('50.000');
    fireEvent.change(byTestId('money.desk.reduce.reason'), { target: { value: 'Pelanggan lama' } });
    fireEvent.click(byTestId('money.desk.reduce.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.reduce')).toBeNull());
    expect(screen.queryByTestId('money.desk.receive')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('money.desk.kas.owed.t-9')).toBeNull());
    expect(text('money.desk.kas.owedBack.t-9.value')).toBe('Rp50.000');

    // It goes back through how it came in, the overpayment filled in.
    const drawer = Number(text('money.desk.kas.expected').replace(/\D/g, ''));
    fireEvent.click(byTestId('money.desk.kas.owedBack.t-9.refund'));
    await screen.findByTestId('money.desk.refund');
    expect(text('money.desk.refund.credit')).toBe('Rp50.000');
    expect(text('money.desk.refund.paid')).toBe('Rp200.000');
    expect(byTestId('money.desk.refund.amount')).toHaveProperty('value', '50.000');
    fireEvent.change(byTestId('money.desk.refund.amount'), { target: { value: '250000' } });
    expect(byTestId('money.desk.refund.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.refund.amount'), { target: { value: '50000' } });
    fireEvent.change(byTestId('money.desk.refund.reason'), { target: { value: 'Kelebihan' } });
    fireEvent.click(byTestId('money.desk.refund.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.refund')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('money.desk.kas.owedBack')).toBeNull());
    expect(Number(text('money.desk.kas.expected').replace(/\D/g, ''))).toBe(drawer - 50_000);
  });

  it('takes a whole debt by QRIS, recorded by the server, and the step just closes', async () => {
    await openKas('Andi Pratama');
    fireEvent.click(await screen.findByTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    const methods = within(byTestId('money.desk.receive.pay.line0.methods'));
    fireEvent.click(methods.getByRole('button', { name: 'QRIS BCA' }));
    fireEvent.click(await screen.findByTestId('money.desk.receive.pay.line0.showQr'));
    expect(text('money.desk.receive.qris.amount')).toBe('Rp450.000');
    fireEvent.click(await screen.findByTestId('money.desk.receive.qris.simulate'));
    fireEvent.click(await screen.findByTestId('money.desk.receive.qris.done'));
    await waitFor(() => expect(text('money.desk.receive.owed')).toBe('Rp0'));
    expect(byTestId('money.desk.receive.submit').textContent).toBe('Selesai');
    fireEvent.click(byTestId('money.desk.receive.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.receive')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('money.desk.kas.owed.t-9')).toBeNull());
  });

  it('takes part of a debt by QRIS and the rest in cash, taking a sum below what QRIS takes by hand', async () => {
    await openKas('Andi Pratama');
    fireEvent.click(await screen.findByTestId('money.desk.kas.owed.t-9.receive'));
    await screen.findByTestId('money.desk.receive');
    const methods = within(byTestId('money.desk.receive.pay.line0.methods'));
    fireEvent.click(methods.getByRole('button', { name: 'QRIS BCA' }));
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '1000' },
    });
    // Below what QRIS takes, the line is taken by hand with its reference.
    expect(screen.queryByTestId('money.desk.receive.pay.line0.showQr')).toBeNull();
    expect(byTestId('money.desk.receive.pay.line0.reference')).toBeTruthy();
    expect(byTestId('money.desk.receive.pay.line0.qrMinimum').textContent).toContain('1.500');
    // No QR for more than is owed: Xendit gives no change.
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '500000' },
    });
    expect(byTestId('money.desk.receive.pay.line0.showQr')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('money.desk.receive.pay.line0.amount'), {
      target: { value: '100000' },
    });
    // A QR line is only paid once the customer pays its QR.
    expect(byTestId('money.desk.receive.submit')).toHaveProperty('disabled', true);
    fireEvent.click(byTestId('money.desk.receive.pay.line0.showQr'));
    fireEvent.click(await screen.findByTestId('money.desk.receive.qris.simulate'));
    fireEvent.click(await screen.findByTestId('money.desk.receive.qris.done'));
    await waitFor(() => expect(text('money.desk.receive.owed')).toBe('Rp350.000'));
    fireEvent.click(byTestId('money.desk.receive.pay.add'));
    expect(byTestId('money.desk.receive.pay.line0.amount')).toHaveProperty('value', '350.000');
    fireEvent.click(byTestId('money.desk.receive.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.receive')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('money.desk.kas.owed.t-9')).toBeNull());
  });

  async function openVoid(): Promise<void> {
    fireEvent.mouseDown(byTestId('money.desk.kas.tabs.history'), { button: 0 });
    fireEvent.click(byTestId('money.desk.kas.tabs.history'));
    const table = await screen.findByTestId('money.desk.history.table');
    const [voidButton] = await within(table).findAllByRole('button', {
      name: /^Batalkan pembayaran/,
    });
    fireEvent.click(voidButton!);
    await screen.findByTestId('money.desk.void');
  }

  it('shows a manager their cancel limit, and asks an owner beyond it', async () => {
    await openKas('Maria Kogoya');
    await openVoid();
    expect(byTestId('money.desk.void.limit').textContent).toBe(
      'Batas pembatalanmu Rp 30.000 per servisan.',
    );
    // Every payment today is beyond it: said up front, and the cancel goes to an owner.
    expect((await screen.findByTestId('money.desk.void.asks')).textContent).toBe(
      'Melebihi batasmu, jadi perlu persetujuan.',
    );
    expect(byTestId('money.desk.void.submit').textContent).toBe('Minta persetujuan');
    fireEvent.change(byTestId('money.desk.void.reason'), { target: { value: 'Salah metode' } });
    fireEvent.click(byTestId('money.desk.void.submit'));
    await screen.findByText('Permintaan dibuat. Pemilik toko akan memutuskan.');
    expect(screen.queryByTestId('money.desk.void')).toBeNull();
  });

  it('lets the counter ask an owner to cancel a payment, and only that', async () => {
    await openKas();
    await openVoid();
    expect(screen.queryByTestId('money.desk.void.limit')).toBeNull();
    expect(byTestId('money.desk.void.asks').textContent).toBe('Perlu persetujuan pemilik toko.');
    expect(byTestId('money.desk.void.submit').textContent).toBe('Minta persetujuan');
  });

  it('moves between days in Riwayat', async () => {
    await openKas();
    fireEvent.mouseDown(byTestId('money.desk.kas.tabs.history'), { button: 0 });
    fireEvent.click(byTestId('money.desk.kas.tabs.history'));
    const table = await screen.findByTestId('money.desk.history.table');
    await within(table).findAllByText('Pembayaran diterima');
    fireEvent.click(byTestId('money.desk.history.previous'));
    await waitFor(() =>
      expect(byTestId('money.desk.history.day').textContent).not.toBe('Hari ini'),
    );
    fireEvent.click(byTestId('money.desk.history.today'));
    expect(byTestId('money.desk.history.day').textContent).toBe('Hari ini');
    expect(byTestId('money.desk.history.next')).toHaveProperty('disabled', true);
  });
});

describe('payment methods in PC Settings', () => {
  async function openMethods(as: string): Promise<void> {
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    );
    await screen.findByTestId('repair.desk.board');
    await switchTo(as);
    fireEvent.click(screen.getByRole('button', { name: 'Pengaturan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Metode pembayaran' }));
    await screen.findByTestId('money.desk.methods.list');
  }

  it('is not in Settings for the counter', async () => {
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    );
    await screen.findByTestId('repair.desk.board');
    fireEvent.click(screen.getByRole('button', { name: 'Pengaturan' }));
    await screen.findByTestId('desktop.settings');
    expect(screen.queryByRole('button', { name: 'Metode pembayaran' })).toBeNull();
  });

  it('adds a head-office method for the stores the owner picks, naming them in the list', async () => {
    await openMethods('Andi Pratama');
    // The "add one so the counter can pick it" hint is for an empty list only.
    expect(screen.queryByText(/supaya kasir bisa memilihnya/)).toBeNull();
    fireEvent.click(byTestId('money.desk.methods.add'));
    await screen.findByTestId('money.desk.methodForm');
    fireEvent.change(byTestId('money.desk.methodForm.name'), { target: { value: 'QRIS Pusat' } });
    fireEvent.click(byTestId('money.desk.methodForm.central'));
    const some = await screen.findByTestId('money.desk.methodForm.scope.some');
    fireEvent.mouseDown(some, { button: 0 });
    fireEvent.click(some);
    fireEvent.click(byTestId('money.desk.methodForm.submit'));
    expect((await screen.findByTestId('money.desk.methodForm.storeError')).textContent).toBe(
      'Pilih paling sedikit satu toko.',
    );
    fireEvent.click(byTestId('money.desk.methodForm.store.01920000-0000-7000-8000-0000000005a2'));
    fireEvent.click(byTestId('money.desk.methodForm.store.01920000-0000-7000-8000-0000000005a3'));
    fireEvent.click(byTestId('money.desk.methodForm.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.methodForm')).toBeNull());
    expect(await screen.findByText('QRIS Pusat disimpan.')).toBeTruthy();
    const row = within(byTestId('money.desk.methods.list')).getByText('QRIS Pusat').closest('li')!;
    expect(row.textContent).toContain('Bolusi Sorong, Bolusi Manokwari');
  });

  it('connects a QRIS method to Xendit with its secret key, and disconnects it after asking', async () => {
    await openMethods('Yosua Wonda');
    fireEvent.click(byTestId('money.desk.methods.row.01920000-0000-7000-8000-00000000a001.open'));
    await screen.findByTestId('money.desk.methodForm');
    expect(
      (await screen.findByTestId('money.desk.methodForm.qris.connected')).textContent,
    ).toContain('Terhubung, mode uji');
    fireEvent.click(byTestId('money.desk.methodForm.qris.disconnect'));
    fireEvent.click(await screen.findByTestId('money.desk.methodForm.qris.confirm.confirm'));
    const key = await screen.findByTestId('money.desk.methodForm.qris.key');
    expect(byTestId('money.desk.methodForm.qris.connect')).toHaveProperty('disabled', true);
    fireEvent.change(key, { target: { value: 'xnd_production_0123456789abcdef' } });
    fireEvent.click(byTestId('money.desk.methodForm.qris.connect'));
    expect(
      (await screen.findByTestId('money.desk.methodForm.qris.connected')).textContent,
    ).toContain('Terhubung');
    expect(byTestId('money.desk.methodForm.qris.connected').textContent).not.toContain('mode uji');
    // Other kinds have nothing to connect.
    fireEvent.click(
      within(byTestId('money.desk.methodForm')).getByRole('button', { name: 'Batal' }),
    );
    await waitFor(() => expect(screen.queryByTestId('money.desk.methodForm')).toBeNull());
    fireEvent.click(byTestId('money.desk.methods.row.01920000-0000-7000-8000-00000000a002.open'));
    await screen.findByTestId('money.desk.methodForm');
    expect(screen.queryByTestId('money.desk.methodForm.qris')).toBeNull();
  });

  it('switches a method off instead of deleting it, and a store owner leaves head-office ones be', async () => {
    await openMethods('Yosua Wonda');
    // The head office's transfer account is listed but not editable here.
    expect(
      screen.queryByTestId('money.desk.methods.row.01920000-0000-7000-8000-00000000a003.open'),
    ).toBeNull();
    fireEvent.click(byTestId('money.desk.methods.row.01920000-0000-7000-8000-00000000a001.open'));
    await screen.findByTestId('money.desk.methodForm');
    expect(byTestId('money.desk.methodForm.kind').textContent).toBe('QRIS');
    fireEvent.click(byTestId('money.desk.methodForm.active'));
    fireEvent.click(byTestId('money.desk.methodForm.submit'));
    await waitFor(() => expect(screen.queryByTestId('money.desk.methodForm')).toBeNull());
    await waitFor(() =>
      expect(
        byTestId('money.desk.methods.row.01920000-0000-7000-8000-00000000a001').textContent,
      ).toContain('Tidak dipakai'),
    );
  });
});
