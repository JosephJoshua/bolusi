// Belanja on the PC over the demo orders: who sees it, placing an order with a scanned part, a
// delivery that lands on the shelf, sending an order to a supplier without WhatsApp, and adding a
// supplier. The rules are the module's; these check the PC asks for and shows the right things.
import { initI18n } from '@bolusi/i18n';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals/desktop';
import idInventoryCatalog from '@bolusi/modules/inventory/i18n/id.json';
import enInventoryCatalog from '@bolusi/modules/inventory/i18n/en.json';
import { registerInventoryCatalog } from '@bolusi/modules/inventory/desktop';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { forgetShownQrs } from '@bolusi/modules/money';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import idPurchasingCatalog from '@bolusi/modules/purchasing/i18n/id.json';
import enPurchasingCatalog from '@bolusi/modules/purchasing/i18n/en.json';
import { registerPurchasingCatalog } from '@bolusi/modules/purchasing/desktop';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/renderer/App.js';

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
  // Only this file's own spies: the setup's layout stubs stay.
  windowOpen?.mockRestore();
  windowOpen = undefined;
});

let windowOpen: ReturnType<typeof spyOnOpen> | undefined;
function spyOnOpen() {
  return vi.spyOn(window, 'open').mockImplementation(() => null);
}

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);
const OWNER = 'Andi Pratama';

async function renderApp(as?: string): Promise<void> {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
  await screen.findByTestId('repair.desk.board');
  if (as !== undefined) await switchTo(as);
}

async function switchTo(name: string): Promise<void> {
  fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await screen.findByTestId('repair.desk.board');
}

async function openBuying(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Belanja' }));
  await screen.findByTestId('purchasing.desk.table');
}

/** The table row that names `text` (a supplier, a stage). */
async function rowWith(text: string): Promise<HTMLElement> {
  const table = byTestId('purchasing.desk.table');
  // The demo seeds its orders as it starts, through the same commands a person runs.
  const [cell] = await within(table).findAllByText(text, {}, { timeout: 5000 });
  return cell!.closest('[role="row"]') as HTMLElement;
}

/** A new order to `supplier` for one Redmi 9 battery, picked by its scanned barcode, placed. */
async function placeOrder(supplier: string, qty: string): Promise<void> {
  fireEvent.keyDown(window, { key: 'F2' });
  await screen.findByTestId('purchasing.desk.form');
  expect(byTestId('purchasing.desk.form.submit')).toHaveProperty('disabled', true);
  expect(byTestId('purchasing.desk.form.hint').textContent).toBe(
    'Pilih supplier dan barangnya dulu.',
  );
  fireEvent.click(await screen.findByRole('radio', { name: new RegExp(supplier) }));
  // A USB scanner types the barcode and presses Enter: that adds the part it names.
  const search = byTestId('purchasing.desk.form.part.search');
  fireEvent.change(search, { target: { value: '6941059648208' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  const qtyField = await screen.findByLabelText('Baterai Xiaomi Redmi 9/Note 9 Original');
  fireEvent.change(qtyField, { target: { value: qty } });
  fireEvent.click(byTestId('purchasing.desk.form.submit'));
  await waitFor(() => expect(screen.queryByTestId('purchasing.desk.form')).toBeNull());
}

describe('Belanja on the PC', () => {
  it('is in the sidebar for owners, not for a technician', async () => {
    await renderApp(OWNER);
    await openBuying();
    expect(await rowWith('Diterima sebagian')).toBeTruthy();

    await switchTo('Budi Santoso');
    expect(screen.queryByRole('button', { name: 'Belanja' })).toBeNull();
  });

  it('places an order with a scanned part and opens it beside the list', async () => {
    await renderApp(OWNER);
    await openBuying();
    await placeOrder('Mitra Ponsel', '5');

    const pane = await screen.findByTestId('purchasing.desk.order');
    await waitFor(() =>
      expect(byTestId('purchasing.desk.order.supplier').textContent).toBe('Mitra Ponsel Jayapura'),
    );
    expect(byTestId('purchasing.desk.order.stage').textContent).toBe('Dipesan');
    expect(
      within(pane).getByText('Pesanan dipesan. Kirim ke supplier lewat WhatsApp.'),
    ).toBeTruthy();
    expect(within(pane).getByText('5 pcs')).toBeTruthy();
  });

  it('receives what came: the order moves on to Selesai', async () => {
    await renderApp(OWNER);
    await openBuying();
    fireEvent.click(await rowWith('Diterima sebagian'));
    await screen.findByTestId('purchasing.desk.order.receive');
    fireEvent.click(byTestId('purchasing.desk.order.receive'));
    await screen.findByTestId('purchasing.desk.receive');
    // It starts at what is still to come on each line, so a full delivery is one click.
    fireEvent.click(byTestId('purchasing.desk.receive.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.receive')).toBeNull());
    await waitFor(() =>
      expect(byTestId('purchasing.desk.order.stage').textContent).toBe('Diterima'),
    );
    expect(screen.getByText('Barang diterima. Stok sudah bertambah.')).toBeTruthy();
    expect(byTestId('purchasing.desk.order.receipts').textContent).toContain('Andi Pratama');

    // Done orders move to Selesai.
    const done = byTestId('purchasing.desk.views.done');
    fireEvent.mouseDown(done, { button: 0 });
    fireEvent.click(done);
    expect(await rowWith('Diterima')).toBeTruthy();
  });

  it('copies the order for a supplier with no WhatsApp number', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = (windowOpen = spyOnOpen());
    await renderApp(OWNER);
    await openBuying();
    await placeOrder('Toko Abadi', '2');
    await screen.findByTestId('purchasing.desk.order.send');
    fireEvent.click(byTestId('purchasing.desk.order.send'));
    expect(await screen.findByText('Pesan disalin. Tempel di chat supplier.')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    const message = writeText.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('Halo Toko Abadi');
    expect(message).toContain('Baterai Xiaomi Redmi 9/Note 9 Original: 2 pcs');
  });

  it('opens WhatsApp on the supplier’s number', async () => {
    const open = (windowOpen = spyOnOpen());
    await renderApp(OWNER);
    await openBuying();
    await placeOrder('Mitra Ponsel', '1');
    fireEvent.click(await screen.findByTestId('purchasing.desk.order.send'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]?.[0])).toMatch(/^https:\/\/wa\.me\/62821/);
  });

  it('adds a supplier from the order form and picks it', async () => {
    await renderApp(OWNER);
    await openBuying();
    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('purchasing.desk.form');
    // Numbers read as the counter writes them, whatever was typed.
    expect(await screen.findByRole('radio', { name: /0821-9988-1122/ })).toBeTruthy();
    fireEvent.click(byTestId('purchasing.desk.form.addSupplier'));
    await screen.findByTestId('purchasing.desk.supplierForm');
    expect(byTestId('purchasing.desk.supplierForm.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('purchasing.desk.supplierForm.name'), {
      target: { value: 'CV Sinar Sorong' },
    });
    fireEvent.click(byTestId('purchasing.desk.supplierForm.submit'));
    await waitFor(() => expect(screen.queryByTestId('purchasing.desk.supplierForm')).toBeNull());
    const picked = await screen.findByRole('radio', { name: /CV Sinar Sorong/ });
    await waitFor(() => expect(picked.getAttribute('aria-checked')).toBe('true'));
  });
});
