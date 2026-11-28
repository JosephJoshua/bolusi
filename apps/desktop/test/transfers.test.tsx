// Kiriman on the PC over the demo transfers: who sees it, receiving what another store sent, sending
// parts with a scanned code, and settling a short transfer with a write-off that asks for its reason.
// The rules are the module's; these check the PC asks for and shows the right things.
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

async function renderApp(as: string): Promise<void> {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
  await onBoard();
  await switchTo(as);
}

async function switchTo(name: string): Promise<void> {
  fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await onBoard();
}

async function openTransfers(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Kiriman' }));
  await screen.findByTestId('inventory.desk.transfers.table');
}

/** The table row that names `text` (a store, a stage), opened beside the list. */
async function openRow(text: string): Promise<HTMLElement> {
  const table = byTestId('inventory.desk.transfers.table');
  const [cell] = await within(table).findAllByText(text, {}, { timeout: 5000 });
  fireEvent.click(cell!.closest('[role="row"]') as HTMLElement);
  return screen.findByTestId('inventory.desk.transfer');
}

describe('Kiriman on the PC', () => {
  it('is under Barang for owners, not for a technician', async () => {
    await renderApp(OWNER);
    await openTransfers();
    await openRow('Dari Toko Manokwari');

    await switchTo('Budi Santoso');
    expect(screen.queryByRole('button', { name: 'Kiriman' })).toBeNull();
  });

  it('receives what another store sent, starting at what is still to come', async () => {
    await renderApp(OWNER);
    await openTransfers();
    await openRow('Dari Toko Manokwari');
    await waitFor(() =>
      expect(byTestId('inventory.desk.transfer.stage').textContent).toBe('Dalam perjalanan'),
    );
    fireEvent.click(byTestId('inventory.desk.transfer.receive'));
    await screen.findByTestId('inventory.desk.receiveTransfer');
    expect(byTestId('inventory.desk.receiveTransfer.submit')).toHaveProperty('disabled', false);
    fireEvent.click(byTestId('inventory.desk.receiveTransfer.submit'));

    await waitFor(() => expect(screen.queryByTestId('inventory.desk.receiveTransfer')).toBeNull());
    await waitFor(() =>
      expect(byTestId('inventory.desk.transfer.stage').textContent).toBe('Selesai'),
    );
    expect(screen.getByText('Barang masuk ke stok.')).toBeTruthy();
    expect(screen.queryByTestId('inventory.desk.transfer.receive')).toBeNull();
  });

  it('sends a scanned part to another store and opens it beside the list', async () => {
    await renderApp(OWNER);
    await openTransfers();
    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('inventory.desk.send');
    expect(byTestId('inventory.desk.send.submit')).toHaveProperty('disabled', true);
    expect(byTestId('inventory.desk.send.hint').textContent).toBe(
      'Pilih toko tujuan dan sparepart terlebih dahulu.',
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'Toko Jayapura' }));
    const search = byTestId('inventory.desk.send.part.search');
    fireEvent.change(search, { target: { value: '6941059648208' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await screen.findByLabelText('Baterai Xiaomi Redmi 9/Note 9 Original');
    expect(byTestId('inventory.desk.send.hint').textContent).toBe(
      'Stok toko ini langsung berkurang.',
    );
    fireEvent.click(byTestId('inventory.desk.send.submit'));

    await waitFor(() => expect(screen.queryByTestId('inventory.desk.send')).toBeNull());
    await waitFor(() =>
      expect(byTestId('inventory.desk.transfer.store').textContent).toBe('Ke Toko Jayapura'),
    );
    expect(byTestId('inventory.desk.transfer.stage').textContent).toBe('Dalam perjalanan');
    expect(screen.getByText('Sparepart dikirim.')).toBeTruthy();
    // Nothing has arrived yet, so the sender may still take it back.
    expect(byTestId('inventory.desk.transfer.cancel')).toBeTruthy();
  });

  it('settles a short transfer, asking why once a part is written off', async () => {
    await renderApp(OWNER);
    await openTransfers();
    await openRow('Sebagian sampai');
    fireEvent.click(byTestId('inventory.desk.transfer.settle'));
    const dialog = await screen.findByTestId('inventory.desk.settle');
    expect(within(dialog).getByText('Belum sampai 1')).toBeTruthy();

    const back = within(dialog).getByLabelText('Kembali ke stok');
    const lost = within(dialog).getByLabelText('Hilang');
    fireEvent.change(back, { target: { value: '0' } });
    fireEvent.change(lost, { target: { value: '1' } });
    expect(byTestId('inventory.desk.settle.hint').textContent).toBe(
      'Tulis alasan terlebih dahulu.',
    );
    expect(byTestId('inventory.desk.settle.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('inventory.desk.settle.reason'), {
      target: { value: 'Jatuh di jalan.' },
    });
    fireEvent.click(byTestId('inventory.desk.settle.submit'));

    await waitFor(() => expect(screen.queryByTestId('inventory.desk.settle')).toBeNull());
    await waitFor(() =>
      expect(byTestId('inventory.desk.transfer.stage').textContent).toBe('Selesai'),
    );
    expect(screen.getByText('Kiriman diselesaikan.')).toBeTruthy();
  });
});
