import { initI18n, setLocale } from '@bolusi/i18n';
import { PAPER_PRESETS, layoutGrid, renderHtml, type PrintDocument } from '@bolusi/core';
import { beforeAll, describe, expect, it } from 'vitest';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { handoverSlip, intakeSlip, slipTerms, type SlipContext } from '../src/repair/print.js';
import type { QuoteLineRow, TicketDetailRow } from '../src/repair/queries.js';

const AT = Date.UTC(2026, 9, 26, 5, 30);

function line(overrides: Partial<QuoteLineRow>): QuoteLineRow {
  return {
    id: 'line',
    kind: 'part',
    description: 'Ganti LCD',
    amount: 850_000,
    status: 'intake',
    reason: null,
    customerAgreed: null,
    createdBy: 'u1',
    createdAt: AT,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...overrides,
  };
}

export function sampleTicket(overrides: Partial<TicketDetailRow> = {}): TicketDetailRow {
  return {
    id: 't1',
    ticketNumber: 'K7Q-0042',
    customerId: 'c1',
    customerName: 'Yohanes Wanimbo',
    customerPhone: '081234567890',
    deviceBrand: 'Samsung',
    deviceModel: 'Galaxy A15',
    deviceColor: 'Hitam',
    deviceImei: '356789012345678',
    complaint: 'Layar retak, touchscreen tidak respon di bagian bawah.',
    outcome: 'received',
    outcomeNote: null,
    location: 'in_store',
    technicianId: null,
    technicianName: null,
    quoteTotal: 950_000,
    estimatedReadyAt: AT + 2 * 86_400_000,
    pendingProposals: 0,
    createdAt: AT,
    updatedAt: AT,
    cancelFee: null,
    cancelStandardFee: null,
    cancelledBy: null,
    cancelledByName: null,
    cancelledAt: null,
    devicePasscode: 'pin:975319',
    intakeNotes: 'Ada goresan di bodi belakang.',
    checklist: [
      { item: 'screen', label: null, state: 'issue', note: 'retak' },
      { item: 'camera', label: null, state: 'ok', note: '' },
      { item: 'speaker', label: 'Speaker bawah', state: 'not_checked', note: '' },
    ],
    peripherals: [{ item: 'charger', label: null }],
    intakePhotos: [],
    createdBy: 'u1',
    createdByName: 'Maria Kasir',
    returnedBy: null,
    returnedAt: null,
    workStarted: false,
    quoteLines: [
      line({ id: 'l1' }),
      line({ id: 'l2', kind: 'labour', description: 'Jasa pasang', amount: 100_000 }),
      line({ id: 'l3', description: 'Ganti baterai', amount: 300_000, status: 'proposed' }),
    ],
    photos: [],
    events: [],
    ...overrides,
  };
}

const ctx: SlipContext = {
  header: { name: 'Bolusi Cell Sorong', lines: ['Jl. Basuki Rahmat 12, Sorong'], logo: null },
  terms: null,
  printedAt: AT + 60_000,
  printNumber: 1,
  printedByName: 'Maria Kasir',
  downPayment: null,
};

function allText(doc: PrintDocument): string {
  return layoutGrid(doc, { ...PAPER_PRESETS.continuous_full, carbonless: false })
    .pages.flat()
    .flatMap((row) => (row.kind === 'text' ? [row.text] : []))
    .join('\n');
}

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

describe('intake slip', () => {
  it('shows the phone as received and the price quoted, never the unlock code', () => {
    const text = allText(intakeSlip(sampleTicket(), ctx));
    expect(text).toContain('TANDA TERIMA SERVISAN');
    expect(text).toContain('K7Q-0042');
    expect(text).toContain('Yohanes Wanimbo');
    expect(text).toContain('Samsung Galaxy A15');
    expect(text).toContain('Speaker bawah: Tidak dicek');
    expect(text).toContain('(retak)');
    expect(text).toContain('Ganti LCD');
    expect(text).toContain('Rp 950.000');
    // A technician's open proposal is not part of what the customer left with.
    expect(text).not.toContain('Ganti baterai');
    expect(text).not.toContain('975319');
    expect(renderHtml(intakeSlip(sampleTicket(), ctx), PAPER_PRESETS.a4)).not.toContain('975319');
  });

  it('marks a reprint and shows the down payment and what is left', () => {
    const text = allText(
      intakeSlip(sampleTicket(), { ...ctx, printNumber: 2, downPayment: 200_000 }),
    );
    expect(text).toContain('Cetak ulang ke-2');
    expect(text).toMatch(/DP\s+-Rp 200\.000/);
    expect(text).toMatch(/Sisa bayar\s+Rp 750\.000/);
  });

  it('prints the store terms one per line instead of the default ones', () => {
    const text = allText(intakeSlip(sampleTicket(), { ...ctx, terms: 'Satu.\n\n  Dua.  ' }));
    expect(text).toContain('1. Satu.');
    expect(text).toContain('2. Dua.');
    expect(text).not.toContain('Bawa nota ini');
    expect(slipTerms(' \n ')).toEqual([]);
  });
});

describe('handover slip', () => {
  const repaired = sampleTicket({
    outcome: 'repaired',
    location: 'returned',
    returnedAt: AT + 3 * 86_400_000,
    technicianName: 'Budi Teknisi',
    quoteTotal: 1_150_000,
    quoteLines: [
      line({ id: 'l1' }),
      line({ id: 'l2', kind: 'labour', description: 'Jasa pasang', amount: 100_000 }),
      line({
        id: 'l3',
        description: 'Ganti baterai',
        amount: 300_000,
        status: 'applied',
        customerAgreed: true,
      }),
      line({
        id: 'l4',
        kind: 'discount',
        description: 'Diskon',
        amount: -100_000,
        status: 'applied',
      }),
      line({ id: 'l5', description: 'Ganti kamera', amount: 500_000, status: 'declined' }),
    ],
  });

  it('lists the work that counts toward the total and how the repair ended', () => {
    const text = allText(
      handoverSlip(repaired, { ...ctx, handedOverByName: 'Maria Kasir', signature: null }),
    );
    expect(text).toContain('NOTA SERVISAN');
    expect(text).toContain('Ganti baterai');
    expect(text).toContain('-Rp 100.000');
    expect(text).not.toContain('Ganti kamera');
    expect(text).toMatch(/Total\s+Rp 1\.150\.000/);
    expect(text).toMatch(/Status\s+: Selesai/);
    expect(text).toContain('Pelanggan, HP sudah diterima');
  });

  it('charges only the cancellation fee on a cancelled servisan', () => {
    const cancelled = sampleTicket({
      outcome: 'cancelled',
      outcomeNote: 'Pelanggan tidak jadi',
      cancelFee: 50_000,
    });
    const text = allText(
      handoverSlip(cancelled, {
        ...ctx,
        handedOverByName: null,
        signature: null,
        downPayment: 20_000,
      }),
    );
    expect(text).toContain('Biaya pembatalan');
    expect(text).toContain('Pelanggan tidak jadi');
    expect(text).not.toContain('Ganti LCD');
    expect(text).toMatch(/Sisa bayar\s+Rp 30\.000/);
  });

  it('shows the on-screen signature on plain paper', () => {
    const signature = { dataUri: 'data:image/png;base64,iVBORw0KGgo=', mono: null };
    const html = renderHtml(
      handoverSlip(repaired, { ...ctx, handedOverByName: null, signature }),
      PAPER_PRESETS.a5,
    );
    expect(html).toContain('class="sig-img"');
  });

  it('follows the language the app is in', () => {
    setLocale('en');
    try {
      expect(allText(intakeSlip(sampleTicket(), ctx))).toContain('REPAIR RECEIPT');
    } finally {
      setLocale('id');
    }
  });
});
