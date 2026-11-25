// A QR the customer may have scanned is never forgotten: after its step closed and the counter
// moved the line to cash, the screen keeps checking it, and once Xendit says it is paid less is due
// and the counter is told. And a QR paid on a screen closed since still counts when it opens again,
// until the payment syncs in.
import { initI18n } from '@bolusi/i18n';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { QrisError, type PaymentAccountRow, type QrisPort } from '@bolusi/modules/money';
import {
  forgetShownQrs,
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
import { useRef, useState } from 'react';
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

/** Xendit behind the server: QRs the test pays when it likes, one open QR per bill. */
function xendit() {
  const charges = new Map<string, QrisCharge>();
  let offline = false;
  const make = (id: string, amount: number): QrisCharge => ({
    id,
    status: 'waiting',
    amount,
    qrString: `QR-${id}`,
    environment: 'live',
    expiresAt: Date.now() + 10 * 60_000,
    paidAt: null,
    cancelledAt: null,
  });
  const reachable = <T,>(value: () => T): Promise<T> =>
    offline ? Promise.reject(new QrisError('offline')) : Promise.resolve(value());
  const port: QrisPort = {
    connections: () =>
      Promise.resolve([{ accountId: ACCOUNT.id, environment: 'live', connectedAt: 0 }]),
    connect: () => Promise.reject(new QrisError('unexpected')),
    disconnect: () => Promise.reject(new QrisError('unexpected')),
    createCharge: (body) => {
      const known = charges.get(body.id);
      if (known !== undefined) return reachable(() => known);
      if ([...charges.values()].some((charge) => charge.status === 'waiting')) {
        return Promise.reject(new QrisError('chargeOpen'));
      }
      const charge = make(body.id, body.amount);
      charges.set(body.id, charge);
      return reachable(() => charge);
    },
    charge: (id) => reachable(() => charges.get(id)!),
    openCharges: () =>
      reachable(() => [...charges.values()].filter((charge) => charge.status === 'waiting')),
    cancel: (id) =>
      reachable(() => {
        const charge = charges.get(id)!;
        if (charge.status !== 'waiting') return charge;
        const cancelled: QrisCharge = { ...charge, status: 'cancelled', cancelledAt: Date.now() };
        charges.set(id, cancelled);
        return cancelled;
      }),
    simulate: () => Promise.reject(new QrisError('unexpected')),
  };
  return {
    port,
    charges,
    /** The customer pays every QR shown so far, cancelled or not: Xendit cannot withdraw one. */
    pay: () => {
      for (const [id, charge] of charges) {
        if (charge.status !== 'paid')
          charges.set(id, { ...charge, status: 'paid', paidAt: Date.now() });
      }
    },
    /** A QR another device of the store showed for the bill. */
    showElsewhere: (id: string, amount: number) => charges.set(id, make(id, amount)),
    setOffline: (value: boolean) => (offline = value),
  };
}

function Checkout({ port }: { readonly port: QrisPort }): React.JSX.Element {
  const [lines, setLines] = useState<readonly PaymentLine[] | null>(null);
  const ids = useRef(0);
  const qris = useQrisCheckout({
    port,
    document: DOCUMENT,
    lines: lines ?? [newPaymentLine('line0', DUE)],
    setLines,
    recorded: new Set(),
    newId: () => `01920000-0000-7000-8000-0000000000${String((ids.current += 1)).padStart(2, 'c')}`,
    untouched: lines === null,
  });
  const entry = paymentEntry(
    DUE - qris.pending,
    qris.lines,
    [ACCOUNT],
    qris.qrAccounts,
    qris.blocking,
  );
  return (
    <>
      <p data-testid="due">{DUE - qris.pending}</p>
      <p data-testid="complete">{String(entry.complete)}</p>
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
          onCancel={qris.cancelOpen}
          onClose={qris.close}
          testId="qr"
        />
      )}
    </>
  );
}

const complete = () => screen.getByTestId('complete').textContent;

/** Cash handed over exactly, on the first line. */
function takeCash(methods: ReturnType<typeof within>) {
  fireEvent.click(methods.getByRole('button', { name: 'Tunai' }));
  fireEvent.change(screen.getByTestId('pay.line0.tendered'), { target: { value: '150000' } });
}

describe('QRs at checkout', () => {
  it('starts a bill on QRIS through Xendit when it is connected', async () => {
    render(<Checkout port={xendit().port} />);
    expect(await screen.findByTestId('pay.line0.showQr')).toBeTruthy();
    const methods = within(screen.getByTestId('pay.line0.methods'));
    expect(methods.getByRole('button', { name: 'QRIS BCA' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps checking a QR left behind, and counts it once the customer paid it', async () => {
    const { port, pay } = xendit();
    render(<Checkout port={port} />);
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    fireEvent.click(screen.getByTestId('qr.close'));
    // The counter moves the line to cash without cancelling: cash cannot be taken yet.
    const methods = within(screen.getByTestId('pay.line0.methods'));
    takeCash(methods);
    expect((await screen.findByTestId('pay.qrisUnresolved')).textContent).toContain('150.000');
    expect(complete()).toBe('false');

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

  it('takes cash only once the QR is cancelled', async () => {
    const { port } = xendit();
    render(<Checkout port={port} />);
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    // The customer says they will pay cash: cancelled from the QR itself.
    fireEvent.click(screen.getByTestId('qr.cancelQr'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    takeCash(within(screen.getByTestId('pay.line0.methods')));
    expect(screen.queryByTestId('pay.qrisUnresolved')).toBeNull();
    expect(complete()).toBe('true');
  });

  it('cancels a QR left behind from the payment, and a later payment of it still counts', async () => {
    const { port, pay } = xendit();
    render(<Checkout port={port} />);
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    fireEvent.click(screen.getByTestId('qr.close'));
    takeCash(within(screen.getByTestId('pay.line0.methods')));
    fireEvent.click(await screen.findByTestId('pay.cancelQr'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByTestId('pay.qrisUnresolved')).toBeNull();
    expect(complete()).toBe('true');
    // The customer pays it anyway: the server records it, and it reaches the ledger by sync as
    // money to give back. This screen no longer waits for it.
    pay();
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(complete()).toBe('true');
  });

  it('a QR shown on another device of the store blocks cash here too', async () => {
    const { port, showElsewhere } = xendit();
    showElsewhere('01920000-0000-7000-8000-0000000000e1', 150_000);
    render(<Checkout port={port} />);
    expect((await screen.findByTestId('pay.qrisUnresolved')).textContent).toContain('150.000');
    takeCash(within(screen.getByTestId('pay.line0.methods')));
    expect(complete()).toBe('false');
    fireEvent.click(screen.getByTestId('pay.cancelQr'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(complete()).toBe('true');
  });

  it('with no connection to cancel, the counter may let the QR go on this device', async () => {
    const { port, setOffline } = xendit();
    render(<Checkout port={port} />);
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    fireEvent.click(screen.getByTestId('qr.close'));
    takeCash(within(screen.getByTestId('pay.line0.methods')));
    setOffline(true);
    fireEvent.click(await screen.findByTestId('pay.cancelQr'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('pay.qrisUnresolved').textContent).toContain('koneksi');
    expect(complete()).toBe('false');
    fireEvent.click(screen.getByTestId('pay.letGo'));
    expect(screen.queryByTestId('pay.qrisUnresolved')).toBeNull();
    expect(complete()).toBe('true');
  });

  it('a new amount cancels the QR shown for the old one before showing another', async () => {
    const { port, charges } = xendit();
    render(<Checkout port={port} />);
    fireEvent.click(await screen.findByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    fireEvent.click(screen.getByTestId('qr.close'));
    fireEvent.change(screen.getByTestId('pay.line0.amount'), { target: { value: '100000' } });
    fireEvent.click(screen.getByTestId('pay.line0.showQr'));
    await screen.findByTestId('qr.code');
    expect([...charges.values()].map((charge) => [charge.amount, charge.status])).toEqual([
      [150_000, 'cancelled'],
      [100_000, 'waiting'],
    ]);
  });
});
