// A QR the customer may have scanned is never forgotten: after its step closed and the counter
// moved the line to cash, the screen keeps checking it, and once Xendit says it is paid less is due
// and the counter is told. And a QR paid on a screen closed since still counts when it opens again,
// until the payment syncs in.
import { initI18n } from '@bolusi/i18n';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import {
  QrisError,
  forgetShownQrs,
  type PaymentAccountRow,
  type QrisPort,
} from '@bolusi/modules/money';
import {
  PaymentLines,
  QrisDialog,
  newPaymentLine,
  paymentEntry,
  type PaymentLine,
  registerMoneyCatalog,
  useQrisCheckout,
} from '@bolusi/modules/money/desktop';
import type { QrisCharge } from '@bolusi/schemas';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  forgetShownQrs();
  vi.useRealTimers();
});

const ACCOUNT: PaymentAccountRow = {
  id: '01920000-0000-7000-8000-00000000a001',
  kind: 'qris',
  name: 'QRIS BCA',
  active: true,
  central: false,
  storeIds: [],
};
const DOCUMENT = {
  kind: 'repair.ticket',
  id: '01920000-0000-7000-8000-0000000000d1',
  label: 'K-1',
};
const DUE = 150_000;

/** Xendit with one QR the test pays when it likes. */
function xendit() {
  let paid = false;
  const charge = (id: string, amount: number): QrisCharge => ({
    id,
    status: paid ? 'paid' : 'waiting',
    amount,
    qrString: `QR-${id}`,
    environment: 'live',
    expiresAt: Date.now() + 15 * 60_000,
    paidAt: paid ? Date.now() : null,
  });
  const amounts = new Map<string, number>();
  const port: QrisPort = {
    connections: () =>
      Promise.resolve([{ accountId: ACCOUNT.id, environment: 'live', connectedAt: 0 }]),
    connect: () => Promise.reject(new QrisError('unexpected')),
    disconnect: () => Promise.reject(new QrisError('unexpected')),
    createCharge: (body) => {
      amounts.set(body.id, body.amount);
      return Promise.resolve(charge(body.id, body.amount));
    },
    charge: (id) => Promise.resolve(charge(id, amounts.get(id) ?? 0)),
    simulate: () => Promise.reject(new QrisError('unexpected')),
  };
  return { port, pay: () => (paid = true) };
}

function Checkout({ port }: { readonly port: QrisPort }): React.JSX.Element {
  const [lines, setLines] = useState<readonly PaymentLine[]>(() => [newPaymentLine('line0', DUE)]);
  let ids = 0;
  const qris = useQrisCheckout({
    port,
    document: DOCUMENT,
    lines,
    setLines,
    recorded: new Set(),
    newId: () => `01920000-0000-7000-8000-0000000000${String((ids += 1)).padStart(2, 'c')}`,
  });
  const entry = paymentEntry(DUE - qris.pending, qris.lines, [ACCOUNT], qris.qrAccounts);
  return (
    <>
      <p data-testid="due">{DUE - qris.pending}</p>
      <PaymentLines
        lines={qris.lines}
        entry={entry}
        accounts={[ACCOUNT]}
        onChange={setLines}
        newKey={() => 'line9'}
        qris={qris}
        testId="pay"
      />
      {qris.open === null ? null : (
        <QrisDialog
          open={qris.open}
          port={port}
          canSimulate={false}
          onPaid={qris.paid}
          onRenew={qris.renew}
          onTakeByHand={qris.takeByHand}
          onClose={qris.close}
          testId="qr"
        />
      )}
    </>
  );
}

describe('QRs at checkout', () => {
  it('keeps checking a QR left behind, and counts it once the customer paid it', async () => {
    const { port, pay } = xendit();
    render(<Checkout port={port} />);
    const methods = within(await screen.findByTestId('pay.line0.methods'));
    fireEvent.click(methods.getByRole('button', { name: 'QRIS BCA' }));
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    fireEvent.click(screen.getByTestId('qr.close'));
    // The counter gives up on the QR and takes cash instead.
    fireEvent.click(methods.getByRole('button', { name: 'Tunai' }));
    expect((await screen.findByTestId('pay.qrisUnresolved')).textContent).toContain('150.000');

    pay();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByTestId('pay.qrisReceived').textContent).toContain('150.000');
    expect(screen.getByTestId('due').textContent).toBe('0');
    expect(screen.queryByTestId('pay.qrisUnresolved')).toBeNull();
    // The cash line now is more than is due: it cannot be taken on top.
    expect(screen.getByTestId('pay.overpaid')).toBeTruthy();
    cleanup();

    // Opened again before the payment synced in, by someone else signed in (a port of their own),
    // the screen still counts it.
    render(<Checkout port={xendit().port} />);
    expect((await screen.findByTestId('pay.qrisReceived')).textContent).toContain('150.000');
    expect(screen.getByTestId('due').textContent).toBe('0');
  });
});
