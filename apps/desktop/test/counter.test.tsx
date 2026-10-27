import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/renderer/App.js';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
});
afterEach(cleanup);

function renderApp(): void {
  render(
    <TooltipProvider>
      <App />
    </TooltipProvider>,
  );
}

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

async function openTicket(name: string): Promise<void> {
  fireEvent.click(await screen.findByText(name));
  await screen.findByTestId('repair.desk.ticket.customer');
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
    fireEvent.click(byTestId('repair.desk.intake.restOk'));
    for (const tile of screen.getAllByTestId(/^repair\.desk\.intake\.photo\./)) {
      await act(async () => {
        fireEvent.click(tile);
      });
    }
    fireEvent.change(byTestId('repair.desk.intake.line.0.description'), {
      target: { value: 'LCD A54' },
    });
    fireEvent.change(byTestId('repair.desk.intake.line.0.amount'), {
      target: { value: '1250000' },
    });
    await waitFor(() => expect(screen.queryByTestId(/^repair\.desk\.intake\.jump\./)).toBeNull());

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(byTestId('repair.desk.ticket.customer').textContent).toBe('Yakobus Mandowen'),
    );
    expect(byTestId('repair.desk.ticket.phone').textContent).toContain('0813-4455-6677');
    expect(byTestId('repair.desk.ticket.total').textContent).toContain('1.250.000');
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
});
