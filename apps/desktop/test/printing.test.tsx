// The counter app with the main process's printing behind it (a fake bridge): the printer picked
// once in Settings, a test page, and slips that go straight to the printer without asking.
import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PrintResult,
  PrintersBridge,
  UpdatesBridge,
  UpdateState,
} from '../src/main/bridge.js';
import { App } from '../src/renderer/App.js';

const ESC = 0x1b;

interface FakePrinters extends PrintersBridge {
  readonly printRaw: ReturnType<typeof vi.fn<PrintersBridge['printRaw']>>;
  readonly printPage: ReturnType<typeof vi.fn<PrintersBridge['printPage']>>;
}

function fakePrinters(
  options: { chosen?: string | null; result?: PrintResult; installed?: string[] } = {},
): FakePrinters {
  let printer = options.chosen ?? null;
  let paper: unknown = null;
  const result = options.result ?? { ok: true };
  const installed = options.installed ?? ['EPSON LX-310', 'Microsoft Print to PDF'];
  return {
    list: () => Promise.resolve(installed.map((name) => ({ name, displayName: name }))),
    settings: () => Promise.resolve({ printer, paper }),
    choose: (name) => {
      printer = name;
      return Promise.resolve();
    },
    setPaper: (next) => {
      paper = next;
      return Promise.resolve();
    },
    printRaw: vi.fn<PrintersBridge['printRaw']>(() => Promise.resolve(result)),
    printPage: vi.fn<PrintersBridge['printPage']>(() => Promise.resolve(result)),
  };
}

function fakeUpdates(state: UpdateState = { kind: 'none' }): UpdatesBridge & {
  readonly install: ReturnType<typeof vi.fn<UpdatesBridge['install']>>;
} {
  return {
    version: () => Promise.resolve('0.1.0'),
    state: () => Promise.resolve(state),
    onChange: () => () => undefined,
    install: vi.fn<UpdatesBridge['install']>(() => Promise.resolve()),
  };
}

function setBridge(printers: PrintersBridge, updates: UpdatesBridge = fakeUpdates()): void {
  (window as { bolusi?: unknown }).bolusi = { printers, updates };
}

beforeEach(() => {
  window.localStorage.clear();
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
});
afterEach(() => {
  cleanup();
  delete (window as { bolusi?: unknown }).bolusi;
});

function renderApp(): void {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
}

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

async function openSettings(): Promise<void> {
  await screen.findByText('Yohanis Wenda');
  fireEvent.click(byTestId('nav.settings'));
  fireEvent.click(await screen.findByTestId('desktop.settings.nav.computer'));
  await screen.findByTestId('repair.desk.printing');
}

async function openPrintFor(name: string): Promise<void> {
  fireEvent.click(byTestId('nav.repair'));
  const tab = await screen.findByTestId('repair.desk.board.views.pickup');
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  fireEvent.click(await screen.findByText(name));
  await screen.findByTestId('repair.desk.ticket.customer');
  fireEvent.click(byTestId('repair.desk.ticket.action.print'));
  await screen.findByTestId('repair.desk.print');
}

function printerRow(name: string): HTMLElement {
  return screen
    .getAllByTestId('repair.desk.printing.printers.option')
    .find((row) => row.textContent === name)!;
}

describe('printing on the counter PC', () => {
  it('picks the printer once and prints a test page on the dot-matrix as ESC/P', async () => {
    const printers = fakePrinters();
    setBridge(printers);
    renderApp();
    await openSettings();
    await screen.findAllByTestId('repair.desk.printing.printers.option');
    // Nothing is picked for the counter: Windows' default is often a PDF printer.
    expect(byTestId('repair.desk.printing.test').hasAttribute('disabled')).toBe(true);
    fireEvent.click(printerRow('EPSON LX-310'));
    await waitFor(() => expect(printerRow('EPSON LX-310').getAttribute('data-state')).toBe('on'));

    fireEvent.click(byTestId('repair.desk.printing.test'));
    await screen.findByTestId('repair.desk.printing.sent');
    expect(printers.printRaw).toHaveBeenCalledTimes(1);
    const [bytes, jobName] = printers.printRaw.mock.calls[0]!;
    expect(jobName).toBe('Halaman uji');
    // ESC @ resets the printer first; the store's name is in the text.
    expect([...bytes.slice(0, 2)]).toEqual([ESC, 0x40]);
    expect(new TextDecoder().decode(bytes)).toContain('HALAMAN UJI');
    expect(printers.printPage).not.toHaveBeenCalled();
  });

  it('sends a slip straight to the chosen printer and counts it without asking', async () => {
    const printers = fakePrinters({ chosen: 'EPSON LX-310' });
    setBridge(printers);
    renderApp();
    await screen.findByText('Yohanis Wenda');
    await openPrintFor('Ester Mandowen');
    expect((await screen.findByText(/Dicetak di EPSON LX-310/)).textContent).toBe(
      'Dicetak di EPSON LX-310, kertas Continuous ½',
    );
    fireEvent.click(byTestId('repair.desk.print.submit'));
    await waitFor(() => expect(screen.queryByTestId('repair.desk.print')).toBeNull());
    expect(screen.queryByTestId('repair.desk.print.ask')).toBeNull();
    expect(new TextDecoder().decode(printers.printRaw.mock.calls[0]![0])).toContain(
      'Ester Mandowen',
    );

    fireEvent.click(byTestId('repair.desk.ticket.action.print'));
    expect((await screen.findByTestId('repair.desk.print.about')).textContent).toContain(
      'Sudah dicetak 1 kali.',
    );
  });

  it('prints plain paper as the page, without a dialog', async () => {
    const printers = fakePrinters({ chosen: 'EPSON L3110', installed: ['EPSON L3110'] });
    setBridge(printers);
    renderApp();
    await openSettings();
    const a4 = await screen.findByTestId('repair.desk.printing.paper.a4');
    fireEvent.click(a4);
    await waitFor(() => expect(a4.getAttribute('data-state')).toBe('on'));
    await openPrintFor('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.print.submit'));
    await waitFor(() => expect(printers.printPage).toHaveBeenCalledTimes(1));
    const [html, paper] = printers.printPage.mock.calls[0]!;
    expect(html).toContain('size: 210mm 297mm');
    expect(paper).toMatchObject({ widthMm: 210, heightMm: 297 });
    expect(printers.printRaw).not.toHaveBeenCalled();
  });

  it('prints on a size the store types, as ESC/P on tractor-feed paper', async () => {
    const printers = fakePrinters({ chosen: 'EPSON LX-310' });
    setBridge(printers);
    renderApp();
    await openSettings();
    fireEvent.click(await screen.findByTestId('repair.desk.printing.paper.custom'));
    const width = await screen.findByTestId('repair.desk.printing.size.width');
    // Out of range: nothing changes, and the range says why.
    fireEvent.change(width, { target: { value: '30' } });
    fireEvent.blur(width);
    await waitFor(() =>
      expect(byTestId('repair.desk.printing.size.range').className).toContain('text-danger'),
    );
    // A good size saves as it is typed, without leaving the field.
    fireEvent.change(width, { target: { value: '216' } });
    // It starts from the paper it had: the store's half forms, tractor-feed.
    expect(byTestId('repair.desk.printing.size.continuous').getAttribute('aria-checked')).toBe(
      'true',
    );
    await waitFor(async () =>
      expect((await printers.settings()).paper).toMatchObject({
        preset: 'custom',
        widthMm: 216,
        continuous: true,
      }),
    );
    await openPrintFor('Ester Mandowen');
    expect(byTestId('repair.desk.print.paper').textContent).toContain('216 × 140 mm');
    fireEvent.click(byTestId('repair.desk.print.submit'));
    await waitFor(() => expect(printers.printRaw).toHaveBeenCalledTimes(1));
  });

  it('says to pick a printer first instead of printing nowhere', async () => {
    setBridge(fakePrinters());
    renderApp();
    await screen.findByText('Yohanis Wenda');
    await openPrintFor('Ester Mandowen');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Pilih printernya dulu di Pengaturan.',
    );
    expect(byTestId('repair.desk.print.submit').hasAttribute('disabled')).toBe(true);
  });

  it('keeps the slip uncounted when the printer is gone, and says what to check', async () => {
    const printers = fakePrinters({
      chosen: 'EPSON LX-310',
      result: { ok: false, problem: 'printerMissing' },
    });
    setBridge(printers);
    renderApp();
    await screen.findByText('Yohanis Wenda');
    await openPrintFor('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.print.submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('Printernya tidak ditemukan');
    // Still open, and the next try is not a reprint.
    expect(byTestId('repair.desk.print.about').textContent).not.toContain('Sudah dicetak');
  });

  it('warns when the chosen printer was removed from Windows', async () => {
    setBridge(fakePrinters({ chosen: 'EPSON LX-300', installed: ['EPSON LX-310'] }));
    renderApp();
    await openSettings();
    expect((await screen.findByText(/tidak terpasang lagi/)).textContent).toBe(
      'EPSON LX-300 tidak terpasang lagi di komputer ini. Pilih printer lain.',
    );
    expect(byTestId('repair.desk.printing.test').hasAttribute('disabled')).toBe(true);
  });

  it('says when Windows has no printer at all', async () => {
    setBridge(fakePrinters({ installed: [] }));
    renderApp();
    await openSettings();
    expect((await screen.findByTestId('repair.desk.printing.none')).textContent).toContain(
      'Belum ada printer',
    );
  });
});

describe('the printer reminder', () => {
  it('says no printer is chosen until one is, and leads to where it is chosen', async () => {
    setBridge(fakePrinters());
    renderApp();
    const reminder = await screen.findByTestId('desktop.printerReminder');
    expect(reminder.getAttribute('aria-label')).toBe('Printer belum dipilih');
    fireEvent.click(reminder);
    await screen.findByTestId('desktop.settings.computer');
    // Gone as soon as the choice is saved, still in Settings.
    fireEvent.click(await screen.findByText('EPSON LX-310'));
    await waitFor(() => expect(screen.queryByTestId('desktop.printerReminder')).toBeNull());
  });

  it("opens this computer's settings again after the person moved to another section", async () => {
    setBridge(fakePrinters());
    renderApp();
    fireEvent.click(await screen.findByTestId('desktop.printerReminder'));
    await screen.findByTestId('desktop.settings.computer');
    fireEvent.click(byTestId('desktop.settings.nav.account'));
    await waitFor(() => expect(screen.queryByTestId('desktop.settings.computer')).toBeNull());
    fireEvent.click(byTestId('desktop.printerReminder'));
    await screen.findByTestId('desktop.settings.computer');
  });

  it('says when the chosen printer is gone', async () => {
    setBridge(fakePrinters({ chosen: 'EPSON LX-300', installed: ['EPSON LX-310'] }));
    renderApp();
    expect((await screen.findByTestId('desktop.printerReminder')).getAttribute('aria-label')).toBe(
      'Printer tidak ditemukan',
    );
  });

  it('stays out of the way once a printer is ready', async () => {
    setBridge(fakePrinters({ chosen: 'EPSON LX-310' }));
    renderApp();
    await screen.findByText('Yohanis Wenda');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('desktop.printerReminder')).toBeNull();
  });
});

describe('updates', () => {
  it('offers a downloaded version in the title bar and shows the installed one in Settings', async () => {
    const updates = fakeUpdates({ kind: 'ready', version: '0.2.0' });
    setBridge(fakePrinters(), updates);
    renderApp();
    const notice = await screen.findByTestId('desktop.update');
    expect(notice.getAttribute('aria-label')).toBe('Versi baru siap');
    // Installing restarts the app, so the notice opens a menu rather than installing on a click.
    fireEvent.pointerDown(notice, { button: 0, pointerType: 'mouse' });
    expect(updates.install).not.toHaveBeenCalled();
    expect(screen.getByText('Terpasang sendiri saat aplikasi ditutup.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pasang sekarang' }));
    expect(updates.install).toHaveBeenCalledTimes(1);
    await openSettings();
    expect((await screen.findByTestId('desktop.version')).textContent).toBe('0.1.0');
  });

  it('shows nothing while there is nothing to install', async () => {
    setBridge(fakePrinters(), fakeUpdates({ kind: 'downloading' }));
    renderApp();
    await screen.findByText('Yohanis Wenda');
    expect(screen.queryByTestId('desktop.update')).toBeNull();
  });
});
