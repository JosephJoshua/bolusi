import { initI18n, setLocale } from '@bolusi/i18n';
import {
  PAPER_PRESETS,
  layoutGrid,
  renderHtml,
  type GridRow,
  type PrintDocument,
} from '@bolusi/core';
import { beforeAll, describe, expect, it } from 'vitest';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';
import {
  handoverSlip,
  intakeSlip,
  slipLink,
  slipTerms,
  type SlipContext,
} from '../src/repair/print.js';

import { AT, line, sampleTicket } from './support/repair-rows.js';

const ctx: SlipContext = {
  header: { name: 'Bolusi Cell Sorong', lines: ['Jl. Basuki Rahmat 12, Sorong'], logo: null },
  terms: null,
  printedAt: AT + 60_000,
  printedByName: 'Maria Kasir',
  link: null,
};

/** A row's printed text: a band beside a picture prints its lead. */
function rowText(row: GridRow): string {
  return row.kind === 'text' ? row.text : row.lead.map((span) => span.text).join('');
}

function allText(doc: PrintDocument): string {
  return layoutGrid(doc, { ...PAPER_PRESETS.continuous_full, carbonless: false })
    .pages.flat()
    .map(rowText)
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
    expect(text).toMatch(/Tidak dicek\s*: .*Speaker bawah/);
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
      intakeSlip(
        sampleTicket({ downPayment: 200_000, slipPrints: { intake: 1, handover: 0 } }),
        ctx,
      ),
    );
    // One earlier print: this is the first reprint, not the second.
    expect(text).toContain('Cetak ulang');
    expect(text).not.toContain('Cetak ulang ke-');
    expect(text).toMatch(/DP\s+-Rp 200\.000/);
    expect(text).toMatch(/Sisa bayar\s+Rp 750\.000/);
  });

  it('numbers the reprints after the first by how many came before', () => {
    const slip = (intake: number) =>
      allText(intakeSlip(sampleTicket({ slipPrints: { intake, handover: 0 } }), ctx));
    expect(slip(0)).not.toContain('Cetak ulang');
    expect(slip(2)).toContain('Cetak ulang ke-2');
    expect(slip(3)).toContain('Cetak ulang ke-3');
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
    expect(text).toContain('KETENTUAN');
  });

  it('charges only the cancellation fee on a cancelled servisan', () => {
    const cancelled = sampleTicket({
      outcome: 'cancelled',
      outcomeNote: 'Pelanggan tidak jadi',
      cancelFee: 50_000,
    });
    const text = allText(
      handoverSlip(
        { ...cancelled, downPayment: 20_000 },
        { ...ctx, handedOverByName: null, signature: null },
      ),
    );
    expect(text).toContain('Biaya pembatalan');
    expect(text).toContain('Pelanggan tidak jadi');
    expect(text).not.toContain('Ganti LCD');
    expect(text).toMatch(/Sudah dibayar\s+-Rp 20\.000/);
    expect(text).toMatch(/Sisa bayar\s+Rp 30\.000/);
    // No repair, so no warranty terms.
    expect(text).not.toContain('KETENTUAN');
  });

  it('takes what an owner lowered off the bill, so a reprint after a refund owes nothing', () => {
    const text = allText(
      handoverSlip(
        { ...repaired, location: 'returned', reduced: 150_000, downPayment: 1_000_000 },
        { ...ctx, handedOverByName: null, signature: null },
      ),
    );
    expect(text).toMatch(/Total\s+Rp 1\.150\.000/);
    expect(text).toMatch(/Potongan\s+-Rp 150\.000/);
    expect(text).toMatch(/Sudah dibayar\s+-Rp 1\.000\.000/);
    expect(text).toMatch(/Sisa bayar\s+Rp 0/);
  });

  it('prints each repair type’s warranty from the day the phone went home', () => {
    const typed = sampleTicket({
      outcome: 'repaired',
      location: 'returned',
      returnedAt: Date.UTC(2026, 9, 1, 3),
      repairTypes: [
        { item: 'screen', label: null, warrantyDays: 30, needsVideo: false },
        { item: 'waterDamage', label: null, warrantyDays: 0, needsVideo: false },
      ],
    });
    const text = allText(handoverSlip(typed, { ...ctx, handedOverByName: null, signature: null }));
    expect(text).toMatch(/Jenis servisan\s+: Ganti layar, Kena air/);
    expect(text).toContain('GARANSI');
    expect(text).toMatch(/Ganti layar\s+: s\/d 31\/10\/2026/);
    expect(text).toMatch(/Kena air\s+: tanpa garansi/);

    const cancelled = allText(
      handoverSlip(
        { ...typed, outcome: 'cancelled', cancelFee: 0 },
        { ...ctx, handedOverByName: null, signature: null },
      ),
    );
    expect(cancelled).not.toContain('GARANSI');
    expect(allText(intakeSlip(typed, ctx))).not.toContain('GARANSI');
  });

  it('a claim names its servisan and prints that one’s warranty, which it never extends', () => {
    const screen = { item: 'screen', label: null, warrantyDays: 30, needsVideo: false };
    const claim = sampleTicket({
      outcome: 'repaired',
      location: 'returned',
      returnedAt: Date.UTC(2026, 9, 20, 3),
      claimOfTicketId: 't0',
      claimOf: {
        id: 't0',
        ticketNumber: 'K7Q-0005',
        repairTypes: [screen],
        returnedAt: Date.UTC(2026, 9, 1, 3),
      },
    });
    const text = allText(handoverSlip(claim, { ...ctx, handedOverByName: null, signature: null }));
    expect(text).toMatch(/Klaim dari\s+: K7Q-0005/);
    expect(text).toMatch(/Ganti layar\s+: s\/d 31\/10\/2026/);
    expect(allText(intakeSlip(claim, ctx))).toMatch(/Klaim dari\s+: K7Q-0005/);
  });

  it('an intake receipt reprinted after pickup does not call the whole bill a DP', () => {
    const text = allText(
      intakeSlip(sampleTicket({ downPayment: 950_000, location: 'returned' }), ctx),
    );
    expect(text).toMatch(/Sudah dibayar\s+-Rp 950\.000/);
    expect(text).not.toMatch(/\bDP\b/);
  });

  it('a slip printed once the phone is paid for reads as paid in full', () => {
    const paid = sampleTicket({ downPayment: 950_000, location: 'returned' });
    const text = allText(
      handoverSlip(paid, { ...ctx, handedOverByName: 'Maria Kasir', signature: null }),
    );
    expect(text).toMatch(/Sudah dibayar\s+-Rp 950\.000/);
    expect(text).toMatch(/Sisa bayar\s+Rp 0/);
    expect(text).not.toMatch(/\bDP\b/);
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

describe('slip layout', () => {
  const papers = Object.values(PAPER_PRESETS);

  it('fits an ordinary intake slip on one short landscape form, the money beside the phone', () => {
    const { geometry, pages } = layoutGrid(
      intakeSlip(sampleTicket(), ctx),
      PAPER_PRESETS.continuous_half,
    );
    expect(pages).toHaveLength(1);
    // At the printer's easy-to-read 1/6", not squeezed to 1/8".
    expect(geometry.linesPerInch).toBe(6);
    const rows = (pages[0] ?? []).flatMap((row) => (row.kind === 'text' ? [row.text] : []));
    expect(rows.some((r) => r.includes('Pelanggan') && r.includes('Ganti LCD'))).toBe(false);
    expect(rows.some((r) => /^(?=.*\S {3,}\S)(?=.*ESTIMASI BIAYA)/.test(r))).toBe(true);
  });

  it('prints the status link beside the signatures and still fits one short form', () => {
    const ticket = sampleTicket();
    const linked = { ...ctx, link: slipLink(ticket, 'https://bolusi.id') };
    for (const doc of [
      intakeSlip(ticket, linked),
      handoverSlip(ticket, { ...linked, handedOverByName: 'Maria Kasir', signature: null }),
    ]) {
      const { geometry, pages } = layoutGrid(doc, PAPER_PRESETS.continuous_half);
      expect(pages).toHaveLength(1);
      expect(geometry.linesPerInch).toBe(6);
      const leads = (pages[0] ?? []).filter((row) => row.kind === 'image').map(rowText);
      expect(leads.join('\n')).toContain('bolusi.id/c/K7M2Q9XA4B');
      expect(leads.join('\n')).toContain('Cek status servisan');
    }
  });

  /** Distinct short words up to `max` characters, so a cut or a dropped word shows up. */
  function filler(prefix: string, max: number): string {
    let out = '';
    for (let i = 1; ; i += 1) {
      const word = `${prefix}${i}`;
      const next = out === '' ? word : `${out} ${word}`;
      if (next.length > max) return out;
      out = next;
    }
  }

  // Every user-entered field at the longest its operation accepts.
  const longest = sampleTicket({
    ticketNumber: filler('n', 40).replace(/ /g, '-'),
    customerName: filler('cn', 200),
    customerPhone: filler('cp', 40),
    deviceBrand: filler('db', 100),
    deviceModel: filler('dm', 100),
    deviceColor: filler('dc', 200),
    deviceImei: filler('im', 40),
    complaint: filler('co', 2000),
    intakeNotes: filler('in', 2000),
    outcome: 'cancelled',
    outcomeNote: filler('cr', 2000),
    cancelFee: 1_000_000_000_000,
    downPayment: 1_000_000_000_000,
    slipPrints: { intake: 98, handover: 98 },
    createdByName: filler('cb', 200),
    checklist: Array.from({ length: 100 }, (_, i) => ({
      item: `custom${i}`,
      label: filler(`k${i}x`, 60),
      state: 'issue' as const,
      note: filler(`kn${i}x`, 200),
    })),
    peripherals: Array.from({ length: 50 }, (_, i) => ({
      item: `acc${i}`,
      label: filler(`a${i}x`, 60),
    })),
    quoteLines: Array.from({ length: 100 }, (_, i) =>
      line({ id: `l${i}`, description: filler(`q${i}x`, 200), amount: 1_000_000_000_000 }),
    ),
  });
  const longCtx: SlipContext = {
    header: {
      name: filler('sn', 100),
      lines: [filler('sa', 300), filler('sp', 100)],
      logo: null,
    },
    terms: filler('t', 2000),
    printedAt: AT,
    printedByName: filler('pb', 200),
    link: null,
  };
  const slips = (): [PrintDocument, PrintDocument] => {
    // A long site too: the link's address beside the signatures must fit as well.
    const linked = {
      ...longCtx,
      link: slipLink(longest, 'https://servisan.bolusi-cell-cabang-manokwari.example'),
    };
    return [
      intakeSlip(longest, linked),
      handoverSlip(longest, { ...linked, handedOverByName: filler('hb', 200), signature: null }),
    ];
  };
  const words = (value: string): string[] => value.split(/[\s():,.-]+/).filter((w) => w !== '');
  const expected = (intake: boolean): string[] =>
    [
      longCtx.header.name,
      ...longCtx.header.lines,
      longCtx.printedByName ?? '',
      longest.customerName,
      longest.customerPhone ?? '',
      longest.deviceColor,
      longest.deviceImei ?? '',
      ...(intake
        ? [
            // The longest servisan is a cancelled one, whose handover slip has no warranty terms.
            longCtx.terms ?? '',
            longest.complaint,
            longest.intakeNotes,
            longest.createdByName ?? '',
            ...longest.checklist.flatMap((c) => [c.label ?? '', c.note]),
            ...longest.peripherals.map((p) => p.label ?? ''),
            ...longest.quoteLines.map((l) => l.description),
          ]
        : [longest.outcomeNote ?? '']),
    ].flatMap(words);

  it.each(papers)('prints every word of the longest values inside the paper ($preset)', (paper) => {
    for (const [i, doc] of slips().entries()) {
      const { geometry, pages } = layoutGrid(doc, paper);
      const line = 216 / geometry.linesPerInch;
      const printed = new Set<string>();
      for (const page of pages) {
        // In 1/216 inch: a text line, or an 8-dot band of a picture.
        const height = page.reduce(
          (sum, row) => sum + (row.kind === 'text' ? line : Math.ceil(row.bitmap.height / 8) * 24),
          0,
        );
        expect(height).toBeLessThanOrEqual((geometry.pageLines - 1) * line);
        for (const row of page) {
          if (row.kind === 'image') {
            expect(rowText(row).length).toBeLessThanOrEqual(row.offset);
          } else {
            expect(row.text.length).toBeLessThanOrEqual(geometry.columns);
            expect(row.spans.map((s) => s.text).join('')).toBe(row.text);
          }
          for (const word of words(rowText(row))) printed.add(word);
        }
      }
      const missing = expected(i === 0).filter((word) => !printed.has(word));
      expect(missing).toEqual([]);
    }
  });

  it.each(papers)('keeps every word of the longest values on plain paper ($preset)', (paper) => {
    for (const [i, doc] of slips().entries()) {
      const html = renderHtml(doc, paper);
      const printed = new Set(words(html.replace(/<[^>]+>/g, ' ')));
      expect(expected(i === 0).filter((word) => !printed.has(word))).toEqual([]);
    }
  });
});

describe('status link', () => {
  it('points at the servisan’s page on the device’s site, in capitals for a smaller code', () => {
    const link = slipLink(sampleTicket(), 'https://bolusi.id/');
    expect(link?.address).toBe('bolusi.id/c/K7M2Q9XA4B');
    expect(link?.title).toBe('Cek status servisan');
    // Version 2 (25 modules): the capitals pack into the code's alphanumeric mode.
    expect(link?.modules).toHaveLength(25);
  });

  it('is left off without a link code or a site', () => {
    expect(slipLink(sampleTicket({ statusCode: null }), 'https://bolusi.id')).toBeNull();
    expect(slipLink(sampleTicket(), null)).toBeNull();
  });
});
