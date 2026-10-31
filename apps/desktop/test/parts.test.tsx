// Parts on the PC over the demo shelf: the Barang page (views, search, a scanned code, Koreksi
// stok, adding an item) and taking and putting back parts in a servisan's pane. The rules are the
// module's; these check the PC asks for and shows the right things.
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

/** The demo opens as the counter; owners' tests switch to Andi, the main owner. */
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

async function showView(view: string): Promise<void> {
  const tab = await screen.findByTestId(`inventory.desk.views.${view}`);
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

async function search(text: string): Promise<void> {
  fireEvent.change(byTestId('inventory.desk.search'), { target: { value: text } });
  await waitFor(() => expect(byTestId('inventory.desk.results').textContent).not.toBe(''));
}

describe('parts on the PC', () => {
  it('lists the shelf for owners and staff; only owners see Stok minus and can add', async () => {
    await renderApp(OWNER);
    await openParts();
    expect(byTestId('inventory.desk.add')).toBeTruthy();
    expect(screen.getByTestId('inventory.desk.views.belowZero').textContent).toMatch(/Stok minus/);

    await switchTo('Budi Santoso');
    await openParts();
    expect(screen.queryByTestId('inventory.desk.add')).toBeNull();
    expect(screen.queryByTestId('inventory.desk.views.belowZero')).toBeNull();
    expect(screen.getByTestId('inventory.desk.views.outOfStock')).toBeTruthy();
  });

  it('shows the items below zero in Stok minus, with their stock in red', async () => {
    await renderApp(OWNER);
    await openParts();
    await showView('belowZero');
    const row = await screen.findByText('Lem B7000 15 ml');
    expect(row).toBeTruthy();
    const stocks = within(byTestId('inventory.desk.table'))
      .getAllByTestId(/^inventory\.desk\.table\.stock\./)
      .map((cell) => cell.textContent);
    expect(stocks.length).toBeGreaterThan(0);
    expect(stocks.every((value) => value!.startsWith('−'))).toBe(true);
  });

  it('opens the item a scanner types and corrects its stock', async () => {
    await renderApp(OWNER);
    await openParts();
    // A USB scanner types the barcode and presses Enter.
    fireEvent.change(byTestId('inventory.desk.search'), { target: { value: '6941059648208' } });
    fireEvent.submit(byTestId('inventory.desk.search').closest('form')!);
    await screen.findByTestId('inventory.desk.part');
    expect((await screen.findByTestId('inventory.desk.part.code')).textContent).toContain('BN54');

    fireEvent.click(byTestId('inventory.desk.part.count'));
    await screen.findByTestId('inventory.desk.count');
    // The count has the keyboard, so a matching count is one Enter.
    await waitFor(() =>
      expect(document.activeElement).toBe(byTestId('inventory.desk.count.counted')),
    );
    fireEvent.change(byTestId('inventory.desk.count.counted'), { target: { value: '7' } });
    fireEvent.click(byTestId('inventory.desk.count.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.count')).toBeNull());
    await waitFor(() => expect(byTestId('inventory.desk.part.stock').textContent).toBe('7'));
    expect(screen.getByText('Stok dikoreksi.')).toBeTruthy();
    expect(byTestId('inventory.desk.part.history').textContent).toContain('Dikoreksi jadi 7');
  });

  it('adds an item with its stock and opens it beside the list', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.add'));
    await screen.findByTestId('inventory.desk.form');
    // Without a category the name is typed.
    fireEvent.click(byTestId('inventory.desk.form.submit'));
    expect(await screen.findByText('Tulis nama barangnya dulu.')).toBeTruthy();
    fireEvent.change(byTestId('inventory.desk.form.name'), {
      target: { value: 'Lem T7000 50 ml' },
    });
    fireEvent.change(byTestId('inventory.desk.form.stock'), { target: { value: '3' } });
    fireEvent.click(byTestId('inventory.desk.form.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.form')).toBeNull());
    await waitFor(() =>
      expect(byTestId('inventory.desk.part.name').textContent).toBe('Lem T7000 50 ml'),
    );
    expect(byTestId('inventory.desk.part.stock').textContent).toBe('3');
    expect(screen.getByText('Barang ditambahkan.')).toBeTruthy();
    await search('lem t7000');
    expect(within(byTestId('inventory.desk.table')).getByText('Lem T7000 50 ml')).toBeTruthy();
  });

  it('builds a name from a category and keeps it for "Tambah lagi"', async () => {
    await renderApp(OWNER);
    await openParts();
    fireEvent.click(byTestId('inventory.desk.add'));
    await screen.findByTestId('inventory.desk.form');
    fireEvent.click(byTestId('inventory.desk.form.category.cat-bat'));
    const quality = await screen.findByTestId('inventory.desk.form.field.q');
    fireEvent.click(within(quality).getByText('Original'));
    const fits = byTestId('inventory.desk.form.field.hp.search');
    fireEvent.change(fits, { target: { value: 'Nokia 3310' } });
    // Not in the demo catalog: it is added as typed.
    fireEvent.click(await screen.findByTestId('inventory.desk.form.field.hp.typed'));
    await waitFor(() =>
      expect(byTestId('inventory.desk.form.autoName.text').textContent).toContain('Nokia 3310'),
    );
    const built = byTestId('inventory.desk.form.autoName.text').textContent!;
    fireEvent.click(byTestId('inventory.desk.form.another'));
    await waitFor(() => expect(screen.getByText(`“${built}” disimpan.`)).toBeTruthy());
    // The category and its fields stay for the next one of the run.
    expect(byTestId('inventory.desk.form.category.cat-bat').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(byTestId('inventory.desk.form.autoName.text').textContent).toBe(built);
  });

  it('takes a part that fits the phone for a servisan in work, then puts it back', async () => {
    await renderApp(OWNER);
    fireEvent.click(await screen.findByText('Maria Kogoya'));
    const section = await screen.findByTestId('repair.desk.ticket.parts');
    fireEvent.click(within(section).getByTestId('repair.desk.ticket.parts.take'));
    await screen.findByTestId('inventory.desk.take');
    // Parts that fit the Oppo A57 come first, before anything is typed.
    const fitting = await screen.findByTestId('inventory.desk.take.fitting');
    expect(fitting.textContent).toContain('Oppo A57');
    expect(byTestId('inventory.desk.take.submit')).toHaveProperty('disabled', true);
    const choice = screen
      .getAllByRole('radio')
      .find((option) => option.textContent!.includes('Oppo A57'))!;
    fireEvent.click(choice);
    fireEvent.click(byTestId('inventory.desk.take.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.take')).toBeNull());
    expect(await screen.findByText('Sparepart diambil.')).toBeTruthy();
    await waitFor(() => expect(section.textContent).toContain('1 diambil'));

    const putBack = within(section).getAllByRole('button', { name: /^Kembalikan / })[0]!;
    fireEvent.click(putBack);
    await screen.findByTestId('inventory.desk.putBack');
    fireEvent.click(byTestId('inventory.desk.putBack.submit'));
    await waitFor(() => expect(screen.queryByTestId('inventory.desk.putBack')).toBeNull());
    expect(await screen.findByText('Sparepart dikembalikan ke stok.')).toBeTruthy();
    await waitFor(() => expect(section.textContent).toContain('Belum ada sparepart.'));
  });

  it('picks the part a scanner types into Ambil sparepart, with the search focused', async () => {
    await renderApp(OWNER);
    fireEvent.click(await screen.findByText('Maria Kogoya'));
    const section = await screen.findByTestId('repair.desk.ticket.parts');
    fireEvent.click(within(section).getByTestId('repair.desk.ticket.parts.take'));
    await screen.findByTestId('inventory.desk.take');
    const search = byTestId('inventory.desk.take.search');
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: '6941059648208' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const picked = await screen.findByTestId('inventory.desk.take.picked');
    expect(picked.textContent).toContain('Baterai Xiaomi Redmi 9/Note 9 Original');
    // The scanner's Enter picks; it never takes on its own.
    expect(screen.getByTestId('inventory.desk.take')).toBeTruthy();
  });

  it('shows the parts on a servisan the technician may not change, without Ambil', async () => {
    await renderApp();
    await switchTo('Budi Santoso');
    // Petrus Yikwa's servisan is Yosua's: Budi sees its parts but cannot take for it.
    fireEvent.change(byTestId('repair.desk.board.search'), { target: { value: 'Petrus' } });
    fireEvent.click(await screen.findByText('Petrus Yikwa'));
    await screen.findByTestId('repair.desk.ticket.customer');
    expect(screen.queryByTestId('repair.desk.ticket.parts.take')).toBeNull();
  });
});
