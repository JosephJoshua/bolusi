// Keeping the parts list on the PC over the demo shelf: the business owner's categories page and
// the sheet that enters many items at once, typed or pasted from Excel. The rules are the
// module's; these check the PC lays them out, saves through them and asks before losing a sheet.
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
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/renderer/App.js';

beforeEach(() => {
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
  registerInventoryCatalog({ id: idInventoryCatalog, en: enInventoryCatalog });
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
  await screen.findByTestId('repair.desk.board');
  if (as !== undefined) await switchTo(as);
}

async function switchTo(name: string): Promise<void> {
  fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await screen.findByTestId('repair.desk.board');
}

async function openParts(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Barang' }));
  await screen.findByTestId('inventory.desk.table');
}

const sheet = (): HTMLElement => byTestId('inventory.desk.bulk.grid.body');
const paste = (text: string): void => {
  sheet().focus();
  fireEvent.paste(sheet(), { clipboardData: { getData: () => text } });
};

describe('categories on the PC', () => {
  it('are for the business owner only, as are many items at once for staff', async () => {
    await renderApp(OWNER);
    await openParts();
    expect(byTestId('inventory.desk.categories')).toBeTruthy();
    expect(byTestId('inventory.desk.bulk')).toBeTruthy();

    await switchTo('Budi Santoso');
    await openParts();
    expect(screen.queryByTestId('inventory.desk.categories')).toBeNull();
    expect(screen.queryByTestId('inventory.desk.bulk')).toBeNull();
  });

  it('renames a field, which carries its place in the name format and renames the items', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.categories'));
    const table = await screen.findByTestId('inventory.desk.categories.table');
    fireEvent.click(await within(table).findByText('Baterai'));
    await screen.findByTestId('inventory.desk.category');
    fireEvent.change(byTestId('inventory.desk.category.field.q.label'), {
      target: { value: 'Grade' },
    });
    expect((byTestId('inventory.desk.category.format') as HTMLInputElement).value).toBe(
      'Baterai {HP} {Grade}',
    );
    fireEvent.click(byTestId('inventory.desk.category.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.category')).toBeNull());
    expect(await screen.findByText(/^Kategori disimpan\./)).toBeTruthy();
    expect(within(table).getByText('HP · Grade')).toBeTruthy();
  });

  it('adds a category with its fields and choices, refusing a format with an unknown field', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.categories'));
    fireEvent.click(await screen.findByTestId('inventory.desk.categories.add'));
    await screen.findByTestId('inventory.desk.category');
    fireEvent.change(byTestId('inventory.desk.category.name'), { target: { value: 'Speaker' } });
    fireEvent.click(byTestId('inventory.desk.category.addField'));
    const label = await screen.findByPlaceholderText('Contoh: Kualitas');
    // The new field's name gets the keyboard.
    expect(document.activeElement).toBe(label);
    fireEvent.change(label, { target: { value: 'Posisi' } });
    const options = screen.getByLabelText('Pilihan baru');
    fireEvent.change(options, { target: { value: 'Atas' } });
    fireEvent.keyDown(options, { key: 'Enter' });
    fireEvent.change(options, { target: { value: 'Bawah' } });
    fireEvent.keyDown(options, { key: 'Enter' });
    expect(byTestId('inventory.desk.category.example').textContent).toBe('Contoh: Speaker Atas');

    fireEvent.change(byTestId('inventory.desk.category.format'), {
      target: { value: 'Speaker {Posisi} {Warna}' },
    });
    fireEvent.click(byTestId('inventory.desk.category.submit'));
    expect(await screen.findByText('Format menyebut kolom yang tidak ada: Warna.')).toBeTruthy();
    fireEvent.change(byTestId('inventory.desk.category.format'), {
      target: { value: 'Speaker {Posisi}' },
    });
    fireEvent.click(byTestId('inventory.desk.category.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.category')).toBeNull());
    expect(
      within(byTestId('inventory.desk.categories.table')).getByText('Speaker {Posisi}'),
    ).toBeTruthy();
  });

  it('marks a field added after a failed save only once it is typed in or saved again', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.categories'));
    fireEvent.click(await screen.findByTestId('inventory.desk.categories.add'));
    await screen.findByTestId('inventory.desk.category');
    fireEvent.click(byTestId('inventory.desk.category.submit'));
    fireEvent.click(byTestId('inventory.desk.category.addField'));
    const label = await screen.findByPlaceholderText('Contoh: Kualitas');
    expect(label.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Isi nama kolom.')).toBeNull();
    fireEvent.click(byTestId('inventory.desk.category.submit'));
    await waitFor(() => expect(label.getAttribute('aria-invalid')).toBe('true'));
  });
});

describe('many items at once on the PC', () => {
  it('pastes a sheet with headings, names each row by the format and saves them with stock', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.bulk'));
    await screen.findByTestId('inventory.desk.bulk.grid');
    fireEvent.change(byTestId('inventory.desk.bulk.category'), { target: { value: 'cat-bat' } });
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: 'Kualitas' })).toBeTruthy(),
    );
    // A sheet from Excel, its columns in another order, the stock with a thousands dot.
    paste('Stok\tKualitas\tHP\r\n1.200\toriginal\tNokia 3310\r\n3\tDouble power\tNokia 105\r\n');
    await waitFor(() =>
      expect(byTestId('inventory.desk.bulk.grid.cell.0.name').textContent).toBe(
        'Baterai Nokia 3310 Original',
      ),
    );
    expect(byTestId('inventory.desk.bulk.save').textContent).toBe('Simpan 2 barang');
    fireEvent.click(byTestId('inventory.desk.bulk.save'));
    expect(await screen.findByText('2 barang disimpan.')).toBeTruthy();
    // The saved rows leave the sheet; one empty row waits.
    expect(screen.queryByTestId('inventory.desk.bulk.grid.row.1')).toBeNull();

    fireEvent.click(byTestId('inventory.desk.bulk.back'));
    await screen.findByTestId('inventory.desk.table');
    fireEvent.change(byTestId('inventory.desk.search'), { target: { value: 'nokia 3310' } });
    const row = await within(byTestId('inventory.desk.table')).findByText(
      'Baterai Nokia 3310 Original',
    );
    expect(row).toBeTruthy();
  });

  it('saves a phone still being looked up with the catalog spelling', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.bulk'));
    await screen.findByTestId('inventory.desk.bulk.grid');
    fireEvent.change(byTestId('inventory.desk.bulk.category'), { target: { value: 'cat-bat' } });
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: 'Kualitas' })).toBeTruthy(),
    );
    // Saved at once, before the lookup the paste started has come back.
    paste('HP\tKualitas\r\ngalaxy a55\tOriginal\r\n');
    fireEvent.click(byTestId('inventory.desk.bulk.save'));
    expect(await screen.findByText('1 barang disimpan.')).toBeTruthy();
    fireEvent.click(byTestId('inventory.desk.bulk.back'));
    fireEvent.change(await screen.findByTestId('inventory.desk.search'), {
      target: { value: 'galaxy a55' },
    });
    expect(
      await within(byTestId('inventory.desk.table')).findByText(
        'Baterai Samsung Galaxy A55 Original',
      ),
    ).toBeTruthy();
  });

  it('keeps a row it cannot save, marked, and saves the rest', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.bulk'));
    await screen.findByTestId('inventory.desk.bulk.grid');
    paste('Lem B7000 50 ml\t\tLEM-50\t\t\t2\r\nKabel data\t\t\t\t\tdua\r\n');
    fireEvent.click(byTestId('inventory.desk.bulk.save'));
    expect(await screen.findByText(/^1 barang disimpan\. 1 baris belum disimpan/)).toBeTruthy();
    const stock = byTestId('inventory.desk.bulk.grid.cell.0.stock');
    expect(stock.textContent).toBe('dua');
    expect(stock.getAttribute('aria-invalid')).toBe('true');
  });

  it('asks before a filled sheet is left', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.bulk'));
    await screen.findByTestId('inventory.desk.bulk.grid');
    paste('Lem B7000 50 ml');
    expect(byTestId('inventory.desk.bulk').getAttribute('data-unsaved')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Servisan' }));
    expect(await screen.findByTestId('inventory.desk.bulk.leave')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tetap di sini' }));
    expect(byTestId('inventory.desk.bulk.grid.cell.0.name').textContent).toBe('Lem B7000 50 ml');
  });
});
