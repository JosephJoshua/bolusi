// The QR the counter shows, over a scripted Xendit: it asks again until the payment is in, says so
// when a check does not get through, tells a refusal apart, and lets the counter take the payment
// by hand. The shared `useQrisCharge` behind it is the phone's too.
import { initI18n } from '@bolusi/i18n';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { QrisError, type QrisPort } from '@bolusi/modules/money';
import { QrisDialog, registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import type { QrisCharge, QrisChargeBody } from '@bolusi/schemas';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BODY: QrisChargeBody = {
  id: '01920000-0000-7000-8000-0000000000c1',
  accountId: '01920000-0000-7000-8000-00000000a001',
  document: { kind: 'repair.ticket', id: '01920000-0000-7000-8000-0000000000d1', label: 'K-1' },
  amount: 150_000,
};

function charge(status: QrisCharge['status'], environment: 'test' | 'live' = 'live'): QrisCharge {
  return {
    id: BODY.id,
    status,
    amount: BODY.amount,
    qrString: '00020101021226',
    environment,
    expiresAt: Date.now() + 15 * 60_000,
    paidAt: status === 'paid' ? Date.now() : null,
  };
}

function port(overrides: Partial<QrisPort>): QrisPort {
  const refuse = () => Promise.reject(new QrisError('unexpected'));
  return {
    connections: refuse,
    connect: refuse,
    disconnect: refuse,
    createCharge: refuse,
    charge: refuse,
    simulate: refuse,
    ...overrides,
  };
}

function show(qris: QrisPort, extra: Partial<Parameters<typeof QrisDialog>[0]> = {}) {
  const handlers = {
    onPaid: vi.fn(),
    onRenew: vi.fn(),
    onTakeByHand: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <QrisDialog
      open={{ key: 'line0', body: BODY }}
      port={qris}
      canSimulate={false}
      {...handlers}
      {...extra}
    />,
  );
  return handlers;
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('the QR at the counter', () => {
  it('asks again until the payment is in, saying when a check did not get through', async () => {
    const answers: (() => Promise<QrisCharge>)[] = [
      () => Promise.reject(new QrisError('offline')),
      () => Promise.resolve(charge('waiting')),
      () => Promise.resolve(charge('paid')),
    ];
    const checks = vi.fn(() => answers.shift()!());
    const handlers = show(
      port({ createCharge: () => Promise.resolve(charge('waiting')), charge: checks }),
    );
    await screen.findByTestId('money.desk.qris.code');
    expect(screen.getByTestId('money.desk.qris.amount').textContent).toMatch(/150\.000/);
    await tick(3_000);
    expect(screen.getByTestId('money.desk.qris.status').textContent).toBe(
      'Koneksi terputus. Mencoba lagi…',
    );
    await tick(3_000);
    expect(screen.getByTestId('money.desk.qris.status').textContent).toMatch(/^Berlaku sampai/);
    await tick(3_000);
    await screen.findByTestId('money.desk.qris.paid');
    expect(handlers.onPaid).toHaveBeenCalledTimes(1);
    // Paid: it stops asking.
    await tick(10_000);
    expect(checks).toHaveBeenCalledTimes(3);
  });

  it('says a refusal, tries again, and lets the counter take it by hand', async () => {
    const createCharge = vi
      .fn<QrisPort['createCharge']>()
      .mockRejectedValueOnce(new QrisError('unavailable'))
      .mockResolvedValueOnce(charge('waiting'));
    const handlers = show(port({ createCharge, charge: () => new Promise(() => undefined) }));
    expect((await screen.findByTestId('money.desk.qris.failed')).textContent).toContain(
      'Xendit belum bisa dihubungi',
    );
    fireEvent.click(screen.getByTestId('money.desk.qris.byHand'));
    expect(handlers.onTakeByHand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('money.desk.qris.retry'));
    await screen.findByTestId('money.desk.qris.code');
    // The same QR is asked for again: one id, one payment, however often it is retried.
    expect(createCharge.mock.calls.map(([body]) => body.id)).toEqual([BODY.id, BODY.id]);
  });

  it('offers a new QR once it expired', async () => {
    const handlers = show(port({ createCharge: () => Promise.resolve(charge('expired')) }));
    await screen.findByTestId('money.desk.qris.expired');
    fireEvent.click(screen.getByTestId('money.desk.qris.renew'));
    expect(handlers.onRenew).toHaveBeenCalledTimes(1);
  });

  it('pays a test-mode QR for someone who manages the method, and only says so to others', async () => {
    const simulate = vi.fn(() => Promise.resolve(charge('paid', 'test')));
    const waiting = () => Promise.resolve(charge('waiting', 'test'));
    show(port({ createCharge: waiting, charge: waiting, simulate }));
    expect(await screen.findByText('Mode uji: tidak ada uang sungguhan.')).toBeTruthy();
    expect(screen.queryByTestId('money.desk.qris.simulate')).toBeNull();
    cleanup();

    const handlers = show(port({ createCharge: waiting, charge: waiting, simulate }), {
      canSimulate: true,
    });
    fireEvent.click(await screen.findByTestId('money.desk.qris.simulate'));
    await screen.findByTestId('money.desk.qris.paid');
    expect(simulate).toHaveBeenCalledWith(BODY.id);
    expect(handlers.onPaid).toHaveBeenCalledTimes(1);
  });
});
