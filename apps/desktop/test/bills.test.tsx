// Supplier bills on the PC over the demo: the Tagihan list for an owner, a bill and how it compares
// with its order, recording one with terms and ongkir, voiding one, and billing an order from its
// pane. The rules are the module's; these check the PC asks for and shows the right things.
import { initI18n } from '@bolusi/i18n';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals/desktop';
import idInventoryCatalog from '@bolusi/modules/inventory/i18n/id.json';
import enInventoryCatalog from '@bolusi/modules/inventory/i18n/en.json';
import { registerInventoryCatalog } from '@bolusi/modules/inventory/desktop';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { forgetShownQrs, registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import idPurchasingCatalog from '@bolusi/modules/purchasing/i18n/id.json';
import enPurchasingCatalog from '@bolusi/modules/purchasing/i18n/en.json';
import { registerPurchasingCatalog } from '@bolusi/modules/purchasing/desktop';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/renderer/App.js';

import { onBoard } from './desk.js';

beforeEach(() => {
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
  registerInventoryCatalog({ id: idInventoryCatalog, en: enInventoryCatalog });
  registerPurchasingCatalog({ id: idPurchasingCatalog, en: enPurchasingCatalog });
});
afterEach(() => {
  cleanup();
  forgetShownQrs();
});

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);
const OWNER = 'Andi Pratama';

async function renderApp(as?: string): Promise<void> {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
  await onBoard();
  if (as !== undefined) await switchTo(as);
}

async function switchTo(name: string): Promise<void> {
  fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await onBoard();
}

async function openBuying(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Belanja' }));
  await screen.findByTestId('purchasing.desk.table');
}

async function openBills(): Promise<void> {
  await openBuying();
  const tab = byTestId('purchasing.desk.views.bills');
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  await screen.findByTestId('purchasing.desk.bills');
}

/** One of the list's views: Belum lunas (the default), Jatuh tempo, Semua. */
function showBills(view: 'unpaid' | 'overdue' | 'all'): void {
  fireEvent.click(byTestId(`purchasing.desk.billFilter.${view}`));
}

/** The bills table row that names `text` (a supplier, a nota). */
async function billWith(text: string | RegExp): Promise<HTMLElement> {
  const table = byTestId('purchasing.desk.bills');
  const [cell] = await within(table).findAllByText(text, {}, { timeout: 5000 });
  return cell!.closest('[role="row"]') as HTMLElement;
}

describe('supplier bills on the PC', () => {
  it('lists the bills for an owner, voided ones marked, and opens one with its checks', async () => {
    await renderApp(OWNER);
    await openBills();
    // Belum lunas leaves out what is paid off or void.
    await billWith('Sumber Jaya Sparepart');
    expect(
      within(byTestId('purchasing.desk.bills')).queryByText(/Nota INV\/MP\/2611.B/),
    ).toBeNull();
    showBills('all');
    const voided = await billWith(/Nota INV\/MP\/2611.B/);
    expect(within(voided).getByText('Dibatalkan')).toBeTruthy();

    fireEvent.click(await billWith('Sumber Jaya Sparepart'));
    const pane = await screen.findByTestId('purchasing.desk.bill');
    // Billed in full while part of the order is still on its way.
    expect(await within(pane).findByTestId('purchasing.desk.bill.check')).toBeTruthy();
    expect(within(pane).getAllByText(/belum datang/).length).toBeGreaterThan(0);
    expect(within(pane).getByText(/Jatuh tempo/)).toBeTruthy();
  });

  it('records a bill on its own with terms, and opens it beside the list', async () => {
    await renderApp(OWNER);
    await openBills();
    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('purchasing.desk.billForm');
    expect(byTestId('purchasing.desk.billForm.submit')).toHaveProperty('disabled', true);
    expect(byTestId('purchasing.desk.billForm.hint').textContent).toBe(
      'Pilih supplier terlebih dahulu.',
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Toko Abadi/ }));
    const search = byTestId('purchasing.desk.billForm.part.search');
    fireEvent.change(search, { target: { value: '6941059648208' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await screen.findByLabelText('Harga satuan');
    expect(byTestId('purchasing.desk.billForm.hint').textContent).toBe('Isi harga setiap barang.');
    fireEvent.change(screen.getByLabelText('Harga satuan'), { target: { value: '85000' } });
    expect((screen.getByLabelText('Harga satuan') as HTMLInputElement).value).toBe('85.000');
    fireEvent.change(byTestId('purchasing.desk.billForm.supplierRef'), {
      target: { value: 'AB-77' },
    });
    fireEvent.click(byTestId('purchasing.desk.billForm.term.14'));
    expect(byTestId('purchasing.desk.billForm.due').textContent).toMatch(/^Jatuh tempo /);
    fireEvent.change(byTestId('purchasing.desk.billForm.charges'), {
      target: { value: '10000' },
    });
    expect(byTestId('purchasing.desk.billForm.total').textContent).toContain('95.000');
    fireEvent.click(byTestId('purchasing.desk.billForm.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.billForm')).toBeNull());

    const pane = await screen.findByTestId('purchasing.desk.bill');
    expect(await within(pane).findByText('Tagihan dicatat.')).toBeTruthy();
    expect(within(pane).getByText(/Nota AB.77/)).toBeTruthy();
    expect(byTestId('purchasing.desk.bill.total').textContent).toContain('95.000');
  });

  it('voids a bill with a reason, and it stays in the list', async () => {
    await renderApp(OWNER);
    await openBills();
    showBills('all');
    fireEvent.click(await billWith('Toko Abadi'));
    fireEvent.click(await screen.findByTestId('purchasing.desk.bill.void'));
    await screen.findByTestId('purchasing.desk.voidBill');
    expect(byTestId('purchasing.desk.voidBill.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('purchasing.desk.voidBill.reason'), {
      target: { value: 'Salah supplier' },
    });
    fireEvent.click(byTestId('purchasing.desk.voidBill.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.voidBill')).toBeNull());
    const pane = byTestId('purchasing.desk.bill');
    expect(await within(pane).findByText('Tagihan dibatalkan.')).toBeTruthy();
    expect(within(pane).getByTestId('purchasing.desk.bill.voided').textContent).toContain(
      'Salah supplier',
    );
    expect(screen.queryByTestId('purchasing.desk.bill.edit')).toBeNull();
  });

  it('pays what is left on an overdue bill from the drawer, then cancels the payment', async () => {
    await renderApp(OWNER);
    await openBills();
    showBills('overdue');
    fireEvent.click(await billWith(/Nota INV\/MP\/2611(?!-)/));
    const pane = await screen.findByTestId('purchasing.desk.bill');
    expect(within(pane).getByTestId('purchasing.desk.bill.balance').textContent).toContain(
      '540.000',
    );
    fireEvent.click(byTestId('purchasing.desk.bill.pay'));
    await screen.findByTestId('purchasing.desk.pay');
    const amount = byTestId('purchasing.desk.pay.amount') as HTMLInputElement;
    expect(amount.value).toBe('540.000');
    fireEvent.change(amount, { target: { value: '600000' } });
    expect(byTestId('purchasing.desk.pay.above').textContent).toContain('kredit supplier');
    fireEvent.change(amount, { target: { value: '540000' } });
    expect(screen.queryByTestId('purchasing.desk.pay.above')).toBeNull();
    // A transfer takes its reference; the drawer does not.
    fireEvent.click(await within(byTestId('purchasing.desk.pay')).findByText('BCA Toko'));
    expect(byTestId('purchasing.desk.pay.reference')).toBeTruthy();
    fireEvent.click(byTestId('purchasing.desk.pay.source.cash'));
    expect(screen.queryByTestId('purchasing.desk.pay.reference')).toBeNull();
    fireEvent.click(byTestId('purchasing.desk.pay.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.pay')).toBeNull());

    expect(await within(pane).findByText('Pembayaran dicatat.')).toBeTruthy();
    await waitFor(() =>
      expect(within(pane).getByTestId('purchasing.desk.bill.balance').textContent).toMatch(/Rp\s0/),
    );
    expect(screen.queryByTestId('purchasing.desk.bill.pay')).toBeNull();

    const cancel = await within(pane).findByRole('button', {
      name: /Batalkan pembayaran Rp\s540\.000/,
    });
    fireEvent.click(cancel);
    await screen.findByTestId('purchasing.desk.voidPayment');
    expect(byTestId('purchasing.desk.voidPayment.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('purchasing.desk.voidPayment.reason'), {
      target: { value: 'Salah tagihan' },
    });
    fireEvent.click(byTestId('purchasing.desk.voidPayment.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.voidPayment')).toBeNull());
    expect(await within(pane).findByText('Dibatalkan: Salah tagihan')).toBeTruthy();
    expect(await within(pane).findByTestId('purchasing.desk.bill.pay')).toBeTruthy();
  });

  it('bills an order from its pane, its parts already listed', async () => {
    await renderApp(OWNER);
    await openBuying();
    const table = byTestId('purchasing.desk.table');
    const [cell] = await within(table).findAllByText('Diterima sebagian', {}, { timeout: 5000 });
    fireEvent.click(cell!.closest('[role="row"]') as HTMLElement);
    const bills = await screen.findByTestId('purchasing.desk.order.bills');
    expect(await within(bills).findByText(/SJ.0912/)).toBeTruthy();
    fireEvent.click(byTestId('purchasing.desk.order.bills.new'));
    await screen.findByTestId('purchasing.desk.billForm');
    expect(byTestId('purchasing.desk.billForm.fromOrder').textContent).toBe(
      'Sumber Jaya Sparepart',
    );
    expect(
      within(byTestId('purchasing.desk.billForm.lines')).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it("opens one of an order's bills in the Tagihan list", async () => {
    await renderApp(OWNER);
    await openBuying();
    const table = byTestId('purchasing.desk.table');
    const [cell] = await within(table).findAllByText('Diterima sebagian', {}, { timeout: 5000 });
    fireEvent.click(cell!.closest('[role="row"]') as HTMLElement);
    const bills = await screen.findByTestId('purchasing.desk.order.bills');
    fireEvent.click((await within(bills).findByText(/SJ.0912/)).closest('button')!);
    await screen.findByTestId('purchasing.desk.bills');
    const pane = await screen.findByTestId('purchasing.desk.bill');
    expect(within(pane).getByText(/Nota SJ.0912/)).toBeTruthy();
  });
});
