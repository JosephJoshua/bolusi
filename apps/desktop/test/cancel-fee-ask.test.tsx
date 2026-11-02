// "Ubah biaya" on the PC for a manager past their limit: the dialog asks an owner instead of
// failing on save, as the phone does, and the owner's yes sets the fee.
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
  RepairRuntimeProvider,
  TicketPane,
} from '@bolusi/modules/repair/desktop';
import { demoRepairRuntime } from '@bolusi/modules/repair/demo';
import { TooltipProvider } from '@bolusi/ui-web';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
});
afterEach(cleanup);

const byTestId = (id: string): HTMLElement => screen.getByTestId(id);

it('asks an owner for a cancelled servisan’s fee beyond the manager’s limit', async () => {
  const runtime = demoRepairRuntime('owner', { now: Date.now() });
  // Rp 150.000 after work: the manager may come down to Rp 100.000 alone.
  await runtime.run('setCancelFees', { beforeWork: 0, afterWork: 150_000 });
  await runtime.run('changeCancelFee', { ticketId: 't-5', fee: 150_000, reason: 'Biaya toko' });
  runtime.actAs('manager');
  render(
    <TooltipProvider>
      <RepairRuntimeProvider runtime={runtime}>
        <TicketPane ticketId="t-5" now={() => Date.now()} onClose={() => undefined} />
      </RepairRuntimeProvider>
    </TooltipProvider>,
  );
  fireEvent.click(await screen.findByTestId('repair.desk.ticket.action.changeCancelFee'));
  await screen.findByTestId('repair.desk.cancelFee');
  // QA round E: owners think in what the customer pays, so the dialog is about the bill.
  expect(byTestId('repair.desk.cancelFee').textContent).toContain(
    'Tagihan sekarang Rp 150.000, sudah dibayar Rp 100.000.',
  );
  expect(screen.getByLabelText('Tagihan baru')).toBe(byTestId('repair.desk.cancelFee.feeInput'));
  const fee = byTestId('repair.desk.cancelFee.feeInput');
  fireEvent.change(fee, { target: { value: '100000' } });
  fireEvent.change(byTestId('repair.desk.cancelFee.reason'), {
    target: { value: 'Pelanggan lama' },
  });
  await waitFor(() => expect(screen.queryByTestId('repair.desk.cancelFee.asks')).toBeNull());
  expect(byTestId('repair.desk.cancelFee.submit').textContent).toBe('Simpan tagihan');
  fireEvent.change(fee, { target: { value: '90000' } });
  await waitFor(() =>
    expect(byTestId('repair.desk.cancelFee.asks').textContent).toBe(
      'Melebihi batasmu, jadi perlu persetujuan.',
    ),
  );
  expect(byTestId('repair.desk.cancelFee.submit').textContent).toBe('Minta persetujuan');
  fireEvent.click(byTestId('repair.desk.cancelFee.submit'));
  await screen.findByText('Permintaan dibuat. Pemilik toko akan memutuskan.');

  const [asked] = (await runtime.approvals.query('approvalRequests', { targetId: 't-5' })).rows;
  expect(asked).toMatchObject({ kind: 'repair.cancelFee', amount: 60_000 });
  await act(async () => {
    runtime.actAs('owner');
    await runtime.approvals.run('approveRequest', { requestId: asked!.id });
  });
  const [row] = (await runtime.query('getTicket', { ticketId: 't-5' })).rows;
  expect(row?.cancelFee).toBe(90_000);
});
