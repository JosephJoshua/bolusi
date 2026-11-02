// QA round E: the PC board's Aktif queue leaves finished phones out, so with only those in the
// store it read "Belum ada servisan aktif." while customers were due. It now points to them.
import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals/desktop';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import {
  registerRepairCatalog,
  RepairBoardPage,
  RepairRuntimeProvider,
  type BoardFilters,
} from '@bolusi/modules/repair/desktop';
import { boardFilter } from '@bolusi/modules/repair';
import { demoRepairRuntime, type DemoRepairRuntime } from '@bolusi/modules/repair/demo';
import { TooltipProvider } from '@bolusi/ui-web';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
});
afterEach(cleanup);

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

function Board(): React.JSX.Element {
  const [filters, setFilters] = useState<BoardFilters | null>(null);
  return (
    <RepairBoardPage
      selectedTicketId={null}
      onSelectTicket={() => undefined}
      onNewIntake={() => undefined}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}

function renderBoard(runtime: DemoRepairRuntime): void {
  render(
    <TooltipProvider>
      <RepairRuntimeProvider runtime={runtime}>
        <Board />
      </RepairRuntimeProvider>
    </TooltipProvider>,
  );
}

async function count(runtime: DemoRepairRuntime, view: 'active' | 'pickup'): Promise<number> {
  const filter = boardFilter(view, 'nobody', 0);
  return (await runtime.query('countTickets', { filter })).rows[0]!.count;
}

it('counts the phones waiting for pickup on their tab, and an empty Aktif points to them', async () => {
  const runtime = demoRepairRuntime('owner', { now: Date.now() });
  // Everything being worked on is cancelled, so only phones waiting for pickup are left.
  const active = await runtime.query('listTickets', {
    filter: boardFilter('active', 'nobody', 0),
    limit: 100,
  });
  for (const row of active.rows)
    await runtime.run('cancelTicket', { ticketId: row.id, reason: 'Pelanggan batal', fee: 0 });
  expect(await count(runtime, 'active')).toBe(0);
  const waiting = await count(runtime, 'pickup');
  expect(waiting).toBeGreaterThan(0);

  renderBoard(runtime);
  await waitFor(() =>
    expect(byTestId('repair.desk.board.views.pickup').textContent).toBe(
      `Siap diambil (${String(waiting)})`,
    ),
  );
  expect(screen.getByText('Belum ada servisan aktif.')).toBeTruthy();
  expect(screen.queryByText('Servisan yang masuk akan muncul di sini.')).toBeNull();
  // An outlined button: "Servisan baru" stays the one filled action.
  const toPickup = byTestId('repair.desk.board.toPickup');
  expect(toPickup.textContent).toBe(`${String(waiting)} HP siap diambil`);
  expect(toPickup.className).not.toContain('bg-primary');
  fireEvent.click(toPickup);
  await waitFor(() =>
    expect(byTestId('repair.desk.board.views.pickup').getAttribute('aria-selected')).toBe('true'),
  );
});

it('leaves the tab plain for a technician, who does not hand phones back', async () => {
  const runtime = demoRepairRuntime('technician', { now: Date.now() });
  expect(await count(runtime, 'pickup')).toBeGreaterThan(0);
  renderBoard(runtime);
  await screen.findByTestId('repair.desk.board.views.pickup');
  await waitFor(() => expect(screen.queryByTestId('repair.desk.board.table')).not.toBeNull());
  expect(byTestId('repair.desk.board.views.pickup').textContent).toBe('Siap diambil');
});
