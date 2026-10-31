// The customer's status page over a stubbed server: what a customer sees for a servisan in the
// store, after pickup, and when the link is wrong, ended or the connection drops; and the front page
// that takes a code typed from the slip.
import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/customer-page';
import type { PublicRepairStatus } from '@bolusi/schemas';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LookupPage } from '../src/status/LookupPage.js';
import { StatusPage } from '../src/status/StatusPage.js';

beforeEach(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
});
afterEach(cleanup);

const IN_REPAIR: PublicRepairStatus = {
  store: {
    name: 'Bolusi Cell Sorong',
    address: 'Jl. Basuki Rahmat No. 12',
    phone: '0812-4800-1234',
  },
  ticketNumber: 'K7Q-0042',
  device: 'Samsung Galaxy A14',
  status: 'in_repair',
  steps: [
    { step: 'received', at: Date.UTC(2026, 9, 27, 2) },
    { step: 'in_repair', at: Date.UTC(2026, 9, 27, 5) },
  ],
  estimatedReadyAt: Date.UTC(2026, 9, 30, 2),
  money: { total: 650_000, paid: 100_000 },
  pendingPrices: [{ description: 'Baterai', amount: 250_000 }],
  repairTypes: [{ item: 'screen', label: null, warrantyDays: 30 }],
  returnedAt: null,
  updatedAt: Date.UTC(2026, 9, 28, 3),
};

/** A server that answers every request with `status` and `body`, counting the requests. */
function serverAnswering(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/** Text without spaces: amounts put "Rp" and the figure apart. */
const squashed = (el: HTMLElement): string => el.textContent!.replace(/\s/g, '');

describe('a servisan in the store', () => {
  test('leads with the status, then what is owed, the price waiting for a yes and the history', async () => {
    const server = serverAnswering(200, IN_REPAIR);
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={server} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sedang diperbaiki' }),
    ).toBeTruthy();
    expect(server).toHaveBeenCalledWith('/v1/public/status/K7M2Q9XA4BRS', expect.anything());
    expect(screen.getByText('Samsung Galaxy A14')).toBeTruthy();
    expect(screen.getByText('Servisan K7Q-0042')).toBeTruthy();
    expect(screen.getByText(/^Perkiraan selesai/)).toBeTruthy();

    const money = squashed(screen.getByTestId('money'));
    expect(money).toContain('TotalRp650.000');
    expect(money).toContain('SudahdibayarRp100.000');
    expect(money).toContain('SisabayarRp550.000');
    expect(squashed(screen.getByTestId('pending-prices'))).toContain('Baterai+Rp250.000');
    // The warranty counts from pickup, so the page says so while the phone is in the store.
    const warranty = screen.getByTestId('warranty').textContent!;
    expect(warranty).toContain('Ganti layar · garansi 30 hari');
    expect(warranty).toContain('Garansi dihitung sejak HP diambil.');

    const history = screen.getByTestId('history').textContent!;
    expect(history.indexOf('Sedang diperbaiki')).toBeLessThan(history.indexOf('Diterima toko'));
  });

  test('chats with the store on WhatsApp with the servisan named, or calls it', async () => {
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={serverAnswering(200, IN_REPAIR)} />);

    const chat = await screen.findByRole('link', { name: 'Chat toko' });
    const url = new URL(chat.getAttribute('href')!);
    expect(url.origin + url.pathname).toBe('https://wa.me/6281248001234');
    expect(url.searchParams.get('text')).toBe(
      'Halo, saya mau tanya servisan K7Q-0042 (Samsung Galaxy A14).',
    );
    expect(chat.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'Telepon' }).getAttribute('href')).toBe(
      'tel:+6281248001234',
    );
  });

  test('loads again on Muat ulang', async () => {
    const server = serverAnswering(200, IN_REPAIR);
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={server} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Muat ulang' }));

    await waitFor(() => expect(server).toHaveBeenCalledTimes(2));
  });

  test('without a store phone there is nothing to contact, so no bar', async () => {
    const status = { ...IN_REPAIR, store: { ...IN_REPAIR.store, phone: '' } };
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={serverAnswering(200, status)} />);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: 'Chat toko' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Telepon' })).toBeNull();
  });
});

describe('after pickup', () => {
  test('shows the pickup date and the warranty end, and what was paid back', async () => {
    const pickedUp = Date.UTC(2026, 9, 29, 3);
    const status: PublicRepairStatus = {
      ...IN_REPAIR,
      status: 'returned',
      steps: [
        ...IN_REPAIR.steps,
        { step: 'repaired', at: pickedUp - 1 },
        { step: 'returned', at: pickedUp },
      ],
      money: { total: 650_000, paid: 700_000 },
      pendingPrices: [],
      returnedAt: pickedUp,
    };
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={serverAnswering(200, status)} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Sudah diambil' })).toBeTruthy();
    expect(screen.getByText(/^Diambil /)).toBeTruthy();
    expect(squashed(screen.getByTestId('money'))).toContain('KelebihanbayarRp50.000');
    expect(screen.queryByTestId('pending-prices')).toBeNull();
    // Once home, the line names the end date, and the "from pickup" note is gone.
    const warranty = screen.getByTestId('warranty').textContent!;
    expect(warranty).toContain('Ganti layar · garansi s/d 28/11/2026');
    expect(warranty).not.toContain('sejak HP diambil');
  });
});

test('paid in full says so, not Rp 0', async () => {
  const status = { ...IN_REPAIR, money: { total: 650_000, paid: 650_000 } };
  render(<StatusPage code="K7M2Q9XA4BRS" fetcher={serverAnswering(200, status)} />);

  expect(squashed(await screen.findByTestId('money'))).toContain('SisabayarLunas');
});

describe('a cancelled servisan', () => {
  test('charges only the cancel fee, and says the phone can be picked up', async () => {
    const status: PublicRepairStatus = {
      ...IN_REPAIR,
      status: 'cancelled',
      steps: [...IN_REPAIR.steps, { step: 'cancelled', at: Date.UTC(2026, 9, 28, 1) }],
      money: { total: 50_000, paid: 100_000 },
      pendingPrices: [],
    };
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={serverAnswering(200, status)} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Dibatalkan' })).toBeTruthy();
    expect(screen.getByText('HP-mu bisa diambil di toko.')).toBeTruthy();
    const money = squashed(screen.getByTestId('money'));
    expect(money).toContain('BiayapembatalanRp50.000');
    expect(money).toContain('KelebihanbayarRp50.000');
  });
});

describe('when there is nothing to show', () => {
  test('an unknown code says to check the slip', async () => {
    render(
      <StatusPage
        code="K7M2Q9XA4BRT"
        fetcher={serverAnswering(404, { error: { code: 'NOT_FOUND', message: 'not found' } })}
      />,
    );

    expect(await screen.findByText('Servisan tidak ditemukan')).toBeTruthy();
  });

  test('an ended link says the warranty is over', async () => {
    render(
      <StatusPage
        code="K7M2Q9XA4BRS"
        fetcher={serverAnswering(404, {
          error: { code: 'NOT_FOUND', message: 'not found', details: { reason: 'ended' } },
        })}
      />,
    );

    expect(await screen.findByText('Link ini sudah berakhir')).toBeTruthy();
  });

  test('no connection offers to try again, and trying again shows the servisan', async () => {
    const server = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(JSON.stringify(IN_REPAIR), { status: 200 }));
    render(<StatusPage code="K7M2Q9XA4BRS" fetcher={server} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Coba lagi' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sedang diperbaiki' }),
    ).toBeTruthy();
  });

  test('a server fault or an answer the page cannot read also offers to try again', async () => {
    for (const server of [serverAnswering(500, {}), serverAnswering(200, { hello: 'world' })]) {
      render(<StatusPage code="K7M2Q9XA4BRS" fetcher={server} />);
      expect(await screen.findByRole('button', { name: 'Coba lagi' })).toBeTruthy();
      cleanup();
    }
  });
});

describe('the front page', () => {
  test('opens the page of a code typed from the slip, the forgiving way', () => {
    const onOpen = vi.fn();
    render(<LookupPage onOpen={onOpen} />);

    fireEvent.change(screen.getByLabelText('Kode servisan'), {
      target: { value: ' k7m2-q9xa-4brs ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cek' }));

    expect(onOpen).toHaveBeenCalledWith('/c/K7M2Q9XA4BRS');
  });

  test('says what a code looks like when it cannot be one', () => {
    const onOpen = vi.fn();
    render(<LookupPage onOpen={onOpen} />);

    fireEvent.change(screen.getByLabelText('Kode servisan'), { target: { value: 'K7Q-0042' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cek' }));

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Kodenya 12 huruf dan angka. Cek lagi, ya.')).toBeTruthy();
  });
});
