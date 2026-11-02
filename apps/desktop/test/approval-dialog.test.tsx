// The PC's answer to one request, over a stand-in port: an approver whose limit it is beyond is
// offered only rejecting, said up front instead of refused after "Setujui".
import { initI18n } from '@bolusi/i18n';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { ApprovalDialog, registerApprovalsCatalog } from '@bolusi/modules/approvals/desktop';
import type { ApprovalRow, ApprovalsPort } from '@bolusi/modules/approvals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
});
afterEach(cleanup);

const REQUEST: ApprovalRow = {
  id: 'ap-1',
  kind: 'repair.downPayment',
  targetType: 'repair_ticket',
  targetId: 't-1',
  input: { ticketId: 't-1', amount: 40_000, reason: 'Salah ketik' },
  amount: 60_000,
  reason: 'Salah ketik',
  requestedBy: 'u-siti',
  requestedByName: 'Siti Rahayu',
  requestedAt: Date.UTC(2026, 9, 28, 3),
  status: 'waiting',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  note: null,
  mine: false,
  canDecide: true,
  counted: 60_000,
  limitedBy: 'money.void_payment',
};

function open(limit: number | null) {
  const run = vi.fn(async () => ({}));
  const port = { limitOf: () => limit, run } as unknown as ApprovalsPort;
  const onDone = vi.fn();
  render(
    <ApprovalDialog
      port={port}
      request={REQUEST}
      description={{ title: 'DP yang benar', amount: 'Rp 40.000', notes: [] }}
      onDone={onDone}
      onClose={() => undefined}
    />,
  );
  return { run, onDone };
}

describe('ApprovalDialog', () => {
  it('offers a manager only rejecting a request beyond their limit, with the note', async () => {
    const { run, onDone } = open(30_000);
    expect(screen.getByTestId('approvals.desk.dialog.approve')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('approvals.desk.dialog.beyondLimit').textContent).toBe(
      'Di atas batasmu Rp 30.000. Hanya pemilik toko yang bisa menyetujui.',
    );
    fireEvent.change(screen.getByTestId('approvals.desk.dialog.note'), {
      target: { value: 'Pakai nota asli' },
    });
    fireEvent.click(screen.getByTestId('approvals.desk.dialog.reject'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(run).toHaveBeenCalledWith('rejectRequest', {
      requestId: 'ap-1',
      note: 'Pakai nota asli',
    });
  });

  it('lets an approver within their limit (or with none) approve', () => {
    open(null);
    expect(screen.getByTestId('approvals.desk.dialog.approve')).toHaveProperty('disabled', false);
    expect(screen.queryByTestId('approvals.desk.dialog.beyondLimit')).toBeNull();
    cleanup();
    open(60_000);
    expect(screen.getByTestId('approvals.desk.dialog.approve')).toHaveProperty('disabled', false);
  });
});
