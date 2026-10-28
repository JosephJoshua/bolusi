import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/renderer/App.js';
import type * as CaptureDialogs from '../src/renderer/capture-dialogs.js';
import type * as Capture from '../src/renderer/capture.js';

// jsdom has no webcam: a photo asked for is taken at once. The dialogs have their own tests.
vi.mock('../src/renderer/capture-dialogs.js', async (importOriginal) => {
  const real = await importOriginal<typeof CaptureDialogs>();
  return {
    ...real,
    createCaptureDialogs: (): ReturnType<typeof real.createCaptureDialogs> => {
      const dialogs = real.createCaptureDialogs();
      return {
        ...dialogs,
        capture: {
          ...dialogs.capture,
          photo: () => Promise.resolve({ bytes: new Uint8Array([0xff, 0xd8]), mime: 'image/jpeg' }),
        },
      };
    },
  };
});

// Nor can it decode a picture: the stand-in photo is kept as it is.
vi.mock('../src/renderer/capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Capture>()),
  compressPhoto: (photo: { bytes: Uint8Array<ArrayBuffer> }) =>
    Promise.resolve({ bytes: photo.bytes, mime: 'image/jpeg' }),
}));

beforeEach(() => {
  window.localStorage.clear();
  URL.createObjectURL = () => 'blob:photo';
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
});
afterEach(cleanup);

function renderApp(): void {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
}

const RETAKE = 'Foto ulang';
const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

async function openTicket(name: string): Promise<void> {
  fireEvent.click(await screen.findByText(name));
  await screen.findByTestId('repair.desk.ticket.customer');
}

async function showView(view: string): Promise<void> {
  const tab = await screen.findByTestId(`repair.desk.board.views.${view}`);
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/** The handover photo and signature, one after the other as the counter takes them. */
async function captureHandover(): Promise<void> {
  for (const tile of ['photo', 'signature']) {
    await act(async () => {
      fireEvent.click(byTestId(`repair.desk.handover.${tile}`));
      await Promise.resolve();
    });
  }
}

describe('counter app over demo data', () => {
  it('lists the store and finds a servisan by a misspelled name', async () => {
    renderApp();
    await screen.findByText('Yohanis Wenda');
    fireEvent.change(byTestId('repair.desk.board.search'), { target: { value: 'yohanes' } });
    await waitFor(() =>
      expect(byTestId('repair.desk.board.results').textContent).toMatch(/ditemukan/),
    );
    expect(screen.getByText('Yohanis Wenda')).toBeTruthy();
    expect(screen.queryByText('Benny Kambu')).toBeNull();
  });

  it('keeps the queue the counter was on after a trip to the intake page', async () => {
    renderApp();
    await screen.findByText('Yohanis Wenda');
    fireEvent.click(byTestId('repair.desk.board.views.pickup'));
    await waitFor(() =>
      expect(byTestId('repair.desk.board.views.pickup').getAttribute('aria-selected')).toBe('true'),
    );
    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('repair.desk.intake');
    fireEvent.click(byTestId('repair.desk.intake.back'));
    await screen.findByTestId('repair.desk.board');
    expect(byTestId('repair.desk.board.views.pickup').getAttribute('aria-selected')).toBe('true');
  });

  it('takes in a phone on one page and opens its servisan beside the board', async () => {
    renderApp();
    await screen.findByText('Yohanis Wenda');
    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('repair.desk.intake');

    // Saving early marks what is missing beside each field, once, and the summary jumps there.
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(screen.getAllByText('Nama pelanggan belum diisi.')).toHaveLength(1);
    fireEvent.click(byTestId('repair.desk.intake.jump.customer'));
    expect(document.activeElement).toBe(byTestId('repair.desk.intake.name'));

    fireEvent.change(byTestId('repair.desk.intake.name'), {
      target: { value: 'Yakobus Mandowen' },
    });
    fireEvent.change(byTestId('repair.desk.intake.phone'), { target: { value: '081344556677' } });
    fireEvent.click(screen.getByRole('button', { name: 'Samsung' }));
    fireEvent.change(byTestId('repair.desk.intake.model'), { target: { value: 'Galaxy A54' } });
    fireEvent.change(byTestId('repair.desk.intake.complaint'), {
      target: { value: 'Layar bergaris' },
    });
    // The lock as the customer draws it, typed as dot numbers on the PC.
    fireEvent.click(screen.getByRole('radio', { name: 'Pola' }));
    const pad = byTestId('repair.desk.intake.lock.pattern');
    for (const key of ['1', '5', '9', '6', 'Enter']) fireEvent.keyDown(pad, { key });
    await waitFor(() => expect(pad.getAttribute('data-value')).toBe('1596'));
    fireEvent.click(byTestId('repair.desk.intake.restOk'));
    const tiles = screen.getAllByTestId(/^repair\.desk\.intake\.photo\./);
    for (const [index, tile] of tiles.entries()) {
      await act(async () => {
        fireEvent.click(tile);
      });
      // Stored one at a time, like a person shooting each angle.
      await waitFor(() => expect(screen.queryAllByText(RETAKE)).toHaveLength(index + 1));
    }
    fireEvent.change(byTestId('repair.desk.intake.line.0.description'), {
      target: { value: 'LCD A54' },
    });
    fireEvent.change(byTestId('repair.desk.intake.line.0.amount'), {
      target: { value: '1250000' },
    });
    // A down payment above the total is refused beside the field; a fair one shows what is left.
    fireEvent.change(byTestId('repair.desk.intake.downPayment'), { target: { value: '2000000' } });
    expect(await screen.findByText('DP-nya lebih besar dari total biaya.')).toBeTruthy();
    fireEvent.change(byTestId('repair.desk.intake.downPayment'), { target: { value: '500000' } });
    await waitFor(() =>
      expect(byTestId('repair.desk.intake.balance').textContent).toContain('750.000'),
    );
    await waitFor(() => expect(screen.queryByTestId(/^repair\.desk\.intake\.jump\./)).toBeNull());

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(byTestId('repair.desk.ticket.customer').textContent).toBe('Yakobus Mandowen'),
    );
    expect(byTestId('repair.desk.ticket.phone').textContent).toContain('0813-4455-6677');
    expect(byTestId('repair.desk.ticket.total').textContent).toContain('1.250.000');
    expect(byTestId('repair.desk.ticket.balance').textContent).toContain('750.000');
    expect(byTestId('repair.desk.ticket.passcode').textContent).toContain('Pola');
    expect(byTestId('repair.desk.ticket.passcode').textContent).not.toContain('1-5-9-6');
    fireEvent.click(screen.getByRole('button', { name: 'Tampilkan' }));
    expect(byTestId('repair.desk.ticket.passcode').textContent).toContain('1-5-9-6');
  });

  it('closes only the dialog on Escape, keeping the servisan open', async () => {
    renderApp();
    await openTicket('Maria Kogoya');
    fireEvent.click(byTestId('repair.desk.ticket.action.decidePrice'));
    await screen.findByTestId('repair.desk.proposal');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('repair.desk.proposal')).toBeNull());
    expect(byTestId('repair.desk.ticket.customer').textContent).toBe('Maria Kogoya');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('repair.desk.ticket.customer')).toBeNull());
  });

  it('offers cancelling a servisan to owners only', async () => {
    renderApp();
    await openTicket('Benny Kambu');
    expect(screen.queryByTestId('repair.desk.ticket.action.cancel')).toBeNull();

    fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Andi Pratama' }));
    await openTicket('Benny Kambu');
    expect(byTestId('repair.desk.ticket.action.cancel')).toBeTruthy();
  });

  it('suggests catalog models as the model is typed and fills in the brand', async () => {
    renderApp();
    await screen.findByText('Yohanis Wenda');
    fireEvent.keyDown(window, { key: 'F2' });
    const model = await screen.findByTestId('repair.desk.intake.model');
    fireEvent.change(model, { target: { value: 'a55' } });
    const list = await screen.findByTestId('repair.desk.intake.models');
    expect(list.textContent).toContain('Galaxy A55');
    fireEvent.keyDown(model, { key: 'Enter' });
    await waitFor(() =>
      expect(byTestId('repair.desk.intake.brand')).toHaveProperty('value', 'Samsung'),
    );
    expect(model).toHaveProperty('value', 'Galaxy A55');
    expect((await screen.findByTestId('repair.desk.intake.modelMatch')).textContent).toContain(
      'Samsung Galaxy A55',
    );
    expect(screen.queryByTestId('repair.desk.intake.models')).toBeNull();
  });

  it('records a down payment at the counter, and only an owner changes one', async () => {
    renderApp();
    await openTicket('Petrus Yikwa');
    fireEvent.click(byTestId('repair.desk.ticket.downPayment.record'));
    await screen.findByTestId('repair.desk.downPayment.record');
    fireEvent.change(byTestId('repair.desk.downPayment.record.amount'), {
      target: { value: '60000' },
    });
    expect(screen.getByText('DP-nya lebih besar dari total biaya.')).toBeTruthy();
    expect(byTestId('repair.desk.downPayment.record.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('repair.desk.downPayment.record.amount'), {
      target: { value: '20000' },
    });
    fireEvent.click(byTestId('repair.desk.downPayment.record.submit'));
    await waitFor(() =>
      expect(byTestId('repair.desk.ticket.balance').textContent).toContain('30.000'),
    );
    expect(screen.queryByTestId('repair.desk.ticket.downPayment.correct')).toBeNull();

    fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Andi Pratama' }));
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.downPayment.correct'));
    await screen.findByTestId('repair.desk.downPayment.correct');
    fireEvent.change(byTestId('repair.desk.downPayment.correct.amount'), {
      target: { value: '80000' },
    });
    // A changed DP needs a reason before it saves.
    expect(byTestId('repair.desk.downPayment.correct.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('repair.desk.downPayment.correct.reason'), {
      target: { value: 'Salah ketik' },
    });
    fireEvent.click(byTestId('repair.desk.downPayment.correct.submit'));
    await waitFor(() =>
      expect(byTestId('repair.desk.ticket.balance').textContent).toContain('35.000'),
    );
  });

  it('hands a phone back only once the rest is paid, with the change shown', async () => {
    renderApp();
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.action.handover'));
    await screen.findByTestId('repair.desk.handover');
    expect(byTestId('repair.desk.handover.balance').textContent).toContain('15.000');
    // The rest is filled in as cash; a counter without the owner's say cannot leave it unpaid.
    expect(byTestId('repair.desk.handover.pay.line0.amount')).toHaveProperty('value', '15.000');
    expect(screen.queryByTestId('repair.desk.handover.payLater')).toBeNull();
    await captureHandover();
    fireEvent.change(byTestId('repair.desk.handover.pay.line0.tendered'), {
      target: { value: '10000' },
    });
    expect(await screen.findByText('Uang diterima kurang dari jumlahnya.')).toBeTruthy();
    expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('repair.desk.handover.pay.line0.tendered'), {
      target: { value: '20000' },
    });
    expect(byTestId('repair.desk.handover.pay.line0.change').textContent).toContain('5.000');
    await waitFor(() =>
      expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', false),
    );
    fireEvent.click(byTestId('repair.desk.handover.submit'));
    await waitFor(() => expect(screen.queryByTestId('repair.desk.handover')).toBeNull());
  });

  it('splits a payment, and an EDC line needs its approval code', async () => {
    renderApp();
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.action.handover'));
    await screen.findByTestId('repair.desk.handover');
    await captureHandover();
    fireEvent.change(byTestId('repair.desk.handover.pay.line0.amount'), {
      target: { value: '5000' },
    });
    expect(byTestId('repair.desk.handover.pay.remaining').textContent).toContain('10.000');
    fireEvent.click(byTestId('repair.desk.handover.pay.add'));
    const second = await screen.findByTestId('repair.desk.handover.pay.line1');
    fireEvent.click(within(second).getByRole('button', { name: 'EDC Mandiri' }));
    expect(byTestId('repair.desk.handover.pay.line1.amount')).toHaveProperty('value', '10.000');
    expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('repair.desk.handover.pay.line1.reference'), {
      target: { value: '123456' },
    });
    await waitFor(() =>
      expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', false),
    );
  });

  it('lets only an owner hand a phone over unpaid, with a reason', async () => {
    renderApp();
    fireEvent.pointerDown(byTestId('desktop.person'), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Andi Pratama' }));
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.action.handover'));
    await screen.findByTestId('repair.desk.handover');
    await captureHandover();
    fireEvent.click(byTestId('repair.desk.handover.payLater'));
    expect(byTestId('repair.desk.handover.debt').textContent).toContain('15.000');
    expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', true);
    fireEvent.change(byTestId('repair.desk.handover.unpaidReason'), {
      target: { value: 'Bayar Jumat' },
    });
    await waitFor(() =>
      expect(byTestId('repair.desk.handover.submit')).toHaveProperty('disabled', false),
    );
  });

  it('prints a slip and counts it once the counter says it printed', async () => {
    const print = vi.fn();
    const frames: HTMLIFrameElement[] = [];
    const append = document.body.append.bind(document.body);
    const spy = vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement) {
          frames.push(node);
          Object.defineProperty(node, 'contentWindow', {
            value: { print, addEventListener: () => undefined },
          });
        }
      }
    });
    renderApp();
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.action.print'));
    await screen.findByTestId('repair.desk.print');
    // Repaired, so the bill is the slip offered first.
    expect(byTestId('repair.desk.print.about').textContent).toContain('Tagihan');
    fireEvent.click(byTestId('repair.desk.print.submit'));
    await screen.findByTestId('repair.desk.print.ask');
    expect(print).toHaveBeenCalledTimes(1);
    expect(frames[0]?.srcdoc).toContain('Ester Mandowen');
    fireEvent.click(screen.getByRole('button', { name: 'Sudah tercetak' }));
    await waitFor(() => expect(screen.queryByTestId('repair.desk.print')).toBeNull());

    fireEvent.click(byTestId('repair.desk.ticket.action.print'));
    expect((await screen.findByTestId('repair.desk.print.about')).textContent).toContain(
      'Sudah dicetak 1 kali.',
    );
    spy.mockRestore();
  });

  it('prints on the paper set once in the settings of this PC', async () => {
    const frames: HTMLIFrameElement[] = [];
    const append = document.body.append.bind(document.body);
    const spy = vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
      append(...nodes);
      for (const node of nodes) {
        if (node instanceof HTMLIFrameElement) {
          frames.push(node);
          Object.defineProperty(node, 'contentWindow', {
            value: { print: () => undefined, addEventListener: () => undefined },
          });
        }
      }
    });
    renderApp();
    await screen.findByText('Yohanis Wenda');
    fireEvent.click(byTestId('nav.settings'));
    const a4 = await screen.findByTestId('repair.desk.printing.paper.a4');
    await waitFor(() =>
      expect(
        byTestId('repair.desk.printing.paper.continuous_half').getAttribute('data-state'),
      ).toBe('on'),
    );
    fireEvent.click(a4);
    await waitFor(() => expect(a4.getAttribute('data-state')).toBe('on'));

    fireEvent.click(byTestId('nav.repair'));
    await showView('pickup');
    await openTicket('Ester Mandowen');
    fireEvent.click(byTestId('repair.desk.ticket.action.print'));
    // The dialog only says the paper; there is nothing to pick at each print.
    expect((await screen.findByTestId('repair.desk.print.paper')).textContent).toBe('Kertas A4');
    expect(screen.queryByTestId('repair.desk.print.paper.a4')).toBeNull();
    fireEvent.click(byTestId('repair.desk.print.submit'));
    await screen.findByTestId('repair.desk.print.ask');
    expect(frames[0]?.srcdoc).toContain('size: 210mm 297mm');
    spy.mockRestore();
  });

  it('collapses the sidebar to icons and remembers it on this PC', async () => {
    window.innerWidth = 1440;
    renderApp();
    await screen.findByText('Yohanis Wenda');
    const shell = byTestId('desktop.shell');
    expect(shell.getAttribute('data-sidebar')).toBe('expanded');
    expect(byTestId('nav.repair').textContent).toBe('Servisan');

    fireEvent.click(byTestId('nav.toggle'));
    expect(shell.getAttribute('data-sidebar')).toBe('collapsed');
    // Icon only, still named for a screen reader and in its tooltip.
    expect(byTestId('nav.repair').textContent).toBe('');
    expect(byTestId('nav.repair').getAttribute('aria-label')).toBe('Servisan');
    expect(window.localStorage.getItem('bolusi.sidebar')).toBe('collapsed');

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(shell.getAttribute('data-sidebar')).toBe('expanded');
    cleanup();

    // A narrow screen starts collapsed, unless the person chose otherwise here.
    window.innerWidth = 1024;
    renderApp();
    expect(byTestId('desktop.shell').getAttribute('data-sidebar')).toBe('expanded');
    cleanup();
    window.localStorage.clear();
    renderApp();
    expect(byTestId('desktop.shell').getAttribute('data-sidebar')).toBe('collapsed');
  });

  it('filters, sorts and pages the queue, and keeps the choice across an intake', async () => {
    renderApp();
    await screen.findByText('Yohanis Wenda');
    const range = (): string => byTestId('repair.desk.board.pagination.range').textContent ?? '';
    await waitFor(() => expect(range()).toMatch(/^1–\d+ dari \d+$/));
    const all = Number(range().split(' dari ')[1]!.replace(/\./g, ''));

    fireEvent.pointerDown(byTestId('repair.desk.board.pagination.size'), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: '25 per halaman' }));
    await waitFor(() => expect(range()).toBe(`1–25 dari ${String(all)}`));
    fireEvent.click(byTestId('repair.desk.board.pagination.page.2'));
    await waitFor(() => expect(range()).toMatch(/^26–/));

    // A status narrows the queue, starts again from page 1, and every row shows it.
    fireEvent.click(byTestId('repair.desk.filter.status'));
    fireEvent.click(
      await screen.findByTestId('repair.desk.filter.status.option.waiting_for_parts'),
    );
    await waitFor(() => expect(range()).toMatch(/^1–\d+ dari \d+$/));
    fireEvent.keyDown(byTestId('repair.desk.filter.status.popover'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('repair.desk.filter.status.popover')).toBeNull(),
    );
    const narrowed = Number(range().split(' dari ')[1]!.replace(/\./g, ''));
    expect(narrowed).toBeLessThan(all);
    const rows = screen.getAllByTestId(/^repair\.desk\.board\.table\.row\./);
    for (const row of rows) expect(row.textContent).toContain('Tunggu sparepart');

    // Sorting by total puts the largest first, across every page the query holds.
    const header = (): HTMLElement => screen.getByRole('columnheader', { name: /Total/ });
    fireEvent.click(screen.getByRole('button', { name: 'Total' }));
    await waitFor(() => expect(header().getAttribute('aria-sort')).not.toBeNull());
    if (header().getAttribute('aria-sort') === 'ascending') {
      fireEvent.click(screen.getByRole('button', { name: 'Total' }));
    }
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /Total/ }).getAttribute('aria-sort')).toBe(
        'descending',
      ),
    );
    const totals = screen
      .getAllByTestId(/^repair\.desk\.board\.table\.row\./)
      .map((row) =>
        Number(/Rp\s?([\d.]+)\s*$/.exec(row.textContent ?? '')![1]!.replace(/\./g, '')),
      );
    expect(totals).toEqual([...totals].sort((a, b) => b - a));

    fireEvent.keyDown(window, { key: 'F2' });
    await screen.findByTestId('repair.desk.intake');
    fireEvent.click(byTestId('repair.desk.intake.back'));
    await screen.findByTestId('repair.desk.board');
    expect(byTestId('repair.desk.filter.status').textContent).toContain('Tunggu sparepart');
  });
});
