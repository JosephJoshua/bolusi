import { describe, expect, it } from 'vitest';

import {
  PAPER_PRESETS,
  QR_MODULE_DOTS,
  layoutGrid,
  qrBitmap,
  renderEscp,
  renderHtml,
  textGeometry,
  toMonoBitmap,
  toPrinterAscii,
  wrapText,
  type GridPage,
  type PaperSettings,
  type PrintDocument,
  type PrintLink,
} from '../../src/index.js';

const LOGO_URI = 'data:image/png;base64,iVBORw0KGgo=';

function sampleDoc(overrides: Partial<PrintDocument> = {}): PrintDocument {
  return {
    jobName: 'Tanda terima K7Q-0042',
    header: {
      name: 'Bolusi Cell Sorong',
      lines: ['Jl. Basuki Rahmat No. 12', '0812-3456-7890'],
      logo: null,
    },
    title: 'TANDA TERIMA SERVISAN',
    reference: 'K7Q-0042',
    meta: ['Diterima 26/10/2026 14.30', 'Estimasi selesai 28/10/2026'],
    blocks: [
      {
        kind: 'fields',
        fields: [
          { label: 'Pelanggan', value: 'Yohanes Wanimbo' },
          { label: 'No. HP', value: '0812 3456 7890' },
          { label: 'HP', value: 'Samsung Galaxy A15' },
          { label: 'Warna', value: 'Hitam' },
        ],
      },
      { kind: 'heading', text: 'Keluhan' },
      {
        kind: 'paragraph',
        text: 'Layar retak dan touchscreen tidak respon di bagian bawah, kadang mati sendiri.',
      },
      { kind: 'heading', text: 'Kondisi saat diterima' },
      { kind: 'list', items: ['Layar: Rusak', 'Kamera: OK', 'Speaker: OK', 'Cas: OK'] },
    ],
    aside: [
      {
        kind: 'amounts',
        rows: [
          { label: 'Ganti LCD', amount: 'Rp 850.000' },
          { label: 'Jasa', amount: 'Rp 100.000' },
        ],
        totals: [{ label: 'Estimasi total', amount: 'Rp 950.000', strong: true }],
      },
      { kind: 'terms', items: ['Bawa nota ini saat mengambil HP.', 'Biaya masih perkiraan.'] },
    ],
    closing: [
      {
        kind: 'signatures',
        slots: [
          { role: 'Pelanggan', name: 'Yohanes Wanimbo', image: null },
          { role: 'Petugas toko', name: null, image: null },
        ],
      },
    ],
    copies: ['Untuk toko', 'Untuk pelanggan'],
    ...overrides,
  };
}

function textRows(paper: PaperSettings, doc = sampleDoc()): string[][] {
  return layoutGrid(doc, paper).pages.map((page) =>
    page.flatMap((row) => (row.kind === 'text' ? [row.text] : [])),
  );
}

describe('printer text', () => {
  it('keeps only printable ASCII, dropping accents and mapping punctuation', () => {
    expect(toPrinterAscii('Café – “Rp 50.000” … ✓')).toBe('Cafe - "Rp 50.000" ... ?');
  });

  it('wraps at spaces, cuts words longer than a line, and keeps explicit breaks', () => {
    expect(wrapText('satu dua tiga empat', 9)).toEqual(['satu dua', 'tiga', 'empat']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\nb', 10)).toEqual(['a', 'b']);
  });
});

describe('paper geometry', () => {
  it('gives 80 pica columns and 66 lines on 9.5 x 11 inch continuous paper', () => {
    expect(textGeometry(PAPER_PRESETS.continuous_full)).toEqual({
      pitch: 10,
      columns: 80,
      leftMargin: 8,
      linesPerInch: 6,
      pageLines: 66,
    });
    expect(textGeometry(PAPER_PRESETS.continuous_half).pageLines).toBe(33);
    expect(textGeometry(PAPER_PRESETS.continuous_half, 8).pageLines).toBe(44);
  });

  it('switches to a smaller pitch on narrow paper so a line still holds labels and amounts', () => {
    expect(textGeometry(PAPER_PRESETS.a5).pitch).toBe(12);
    const narrow = textGeometry({ ...PAPER_PRESETS.a5, preset: 'custom', widthMm: 100 });
    expect(narrow.pitch).toBe(17);
    expect(narrow.columns).toBeGreaterThanOrEqual(56);
  });
});

describe('text-mode layout', () => {
  const papers: PaperSettings[] = [
    ...Object.values(PAPER_PRESETS),
    { ...PAPER_PRESETS.a5, preset: 'custom', widthMm: 80, heightMm: 120 },
  ];

  it.each(papers)(
    'never prints past the line or below the perforation ($preset, $widthMm mm)',
    (paper) => {
      const { geometry, pages } = layoutGrid(sampleDoc(), paper);
      for (const page of pages) {
        expect(page.length).toBeLessThanOrEqual(geometry.pageLines - 1);
        expect(page[0]).toMatchObject({ kind: 'text', text: '' });
        for (const row of page)
          if (row.kind === 'text') expect(row.text.length).toBeLessThanOrEqual(geometry.columns);
      }
    },
  );

  it('prints once without copy labels on carbonless paper, and a labelled copy each on plain paper', () => {
    const carbon = textRows(PAPER_PRESETS.continuous_full);
    expect(carbon).toHaveLength(1);
    expect(carbon.flat().join('\n')).not.toMatch(/Untuk (toko|pelanggan)/);

    const plain = layoutGrid(sampleDoc(), { ...PAPER_PRESETS.continuous_full, carbonless: false });
    const all = plain.pages
      .flat()
      .flatMap((r) => (r.kind === 'text' ? [r.text] : []))
      .join('\n');
    expect(all).toContain('Untuk toko');
    expect(all).toContain('Untuk pelanggan');
    expect(all).not.toContain('Lembar merah muda');
  });

  it('keeps the signature block whole when the content runs onto a second page', () => {
    const long = sampleDoc({
      blocks: [
        {
          kind: 'list',
          items: Array.from({ length: 40 }, (_, i) => `Pemeriksaan nomor ${i + 1}: OK`),
        },
        ...sampleDoc().blocks,
      ],
    });
    const pages = textRows(PAPER_PRESETS.continuous_half, long);
    expect(pages.length).toBeGreaterThan(1);
    const withRole = pages.filter((rows) => rows.some((r) => r.includes('Petugas toko')));
    expect(withRole).toHaveLength(1);
    expect(
      withRole[0]?.some((r) => r.includes('Yohanes Wanimbo') && r.trim().startsWith('Yohanes')),
    ).toBe(true);
    // A continuation page says which document it belongs to.
    expect(pages[1]?.[1]).toMatch(/K7Q-0042 \(2\)$/);
  });

  it('sets the money and terms beside the body on landscape paper, and under it on portrait', () => {
    const beside = (rows: string[]): boolean =>
      rows.some((r) => r.startsWith('Pelanggan') && r.includes('Ganti LCD'));
    expect(beside(textRows(PAPER_PRESETS.continuous_half)[0] ?? [])).toBe(true);
    expect(beside(textRows(PAPER_PRESETS.a5_landscape)[0] ?? [])).toBe(true);
    expect(beside(textRows(PAPER_PRESETS.continuous_full)[0] ?? [])).toBe(false);
    expect(beside(textRows(PAPER_PRESETS.a4)[0] ?? [])).toBe(false);
  });

  it('keeps bold to its own column when two columns share a line', () => {
    const doc = sampleDoc({ aside: [{ kind: 'heading', text: 'Biaya' }, ...sampleDoc().aside] });
    const row = layoutGrid(doc, PAPER_PRESETS.continuous_half)
      .pages.flat()
      .find((r) => r.kind === 'text' && r.text.includes('BIAYA'));
    expect(row?.kind === 'text' && row.spans).toEqual([
      { text: expect.stringMatching(/^Pelanggan .* {3,}$/) as string, bold: false },
      { text: 'BIAYA', bold: true },
    ]);
    const bytes = new TextDecoder('latin1').decode(renderEscp(doc, PAPER_PRESETS.continuous_half));
    expect(bytes).toMatch(/Pelanggan[^\x1b\r]* {3,}\x1bEBIAYA\x1bF\r\n/);
  });

  it('leaves a blank line between sections and under each title when there is room', () => {
    const rows = textRows(PAPER_PRESETS.continuous_full)[0] ?? [];
    const at = rows.findIndex((r) => r.startsWith('KELUHAN'));
    expect(rows[at - 1]).toBe('');
    expect(rows[at + 1]).toBe('');
    expect(rows[at + 2]).toMatch(/^Layar retak/);
  });

  it('tightens the line spacing before spilling onto a second form', () => {
    const paper = PAPER_PRESETS.continuous_half;
    expect(layoutGrid(sampleDoc(), paper).geometry.linesPerInch).toBe(6);
    const longer = sampleDoc({
      blocks: [
        ...sampleDoc().blocks,
        // Typed on separate lines, which text mode keeps.
        {
          kind: 'paragraph',
          text: Array.from({ length: 22 }, (_, i) => `Catatan ${i}`).join('\n'),
        },
      ],
    });
    const { geometry, pages } = layoutGrid(longer, paper);
    expect(pages).toHaveLength(1);
    expect(geometry.linesPerInch).toBe(8);
    const rows = (pages[0] ?? []).flatMap((r) => (r.kind === 'text' ? [r.text] : []));
    // The notes run down the body column, beside the aside where it reaches.
    expect(rows.some((r) => r.startsWith('Catatan 0 '))).toBe(true);
    expect(rows.some((r) => r.startsWith('Catatan 21'))).toBe(true);
    const bytes = [...renderEscp(longer, paper)];
    // ESC 0 (1/8") set before ESC C 44, the form length in those lines.
    const at = bytes.indexOf(0x43, 5);
    expect(bytes.slice(at - 3, at + 2)).toEqual([0x1b, 0x30, 0x1b, 0x43, 44]);
  });

  it("moves the aside's trailing sections under the body when that makes the columns shorter", () => {
    const terms = Array.from(
      { length: 6 },
      (_, i) => `Ketentuan nomor ${i + 1} yang cukup panjang.`,
    );
    const doc = sampleDoc({
      blocks: sampleDoc().blocks.slice(0, 1),
      aside: [
        ...sampleDoc().aside.slice(0, 1),
        { kind: 'heading', text: 'Ketentuan' },
        { kind: 'terms', items: terms },
      ],
    });
    const rows = textRows(PAPER_PRESETS.continuous_half, doc)[0] ?? [];
    // Under the body, at the left margin, rather than squeezed beside it.
    expect(rows.some((r) => r.startsWith('KETENTUAN'))).toBe(true);
    expect(rows.some((r) => r.startsWith('1. Ketentuan nomor 1'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Pelanggan') && r.includes('Ganti LCD'))).toBe(true);
  });

  it('starts each form a line down and gives spare lines to the signatures', () => {
    const { pages } = layoutGrid(sampleDoc(), PAPER_PRESETS.continuous_half);
    const rows = (pages[0] ?? []).flatMap((r) => (r.kind === 'text' ? [r.text] : []));
    expect(rows[0]).toBe('');
    expect(rows[1]?.trim()).toBe('Bolusi Cell Sorong');
    const roles = rows.findIndex((r) => r.includes('Petugas toko'));
    const above = rows
      .slice(0, roles)
      .reverse()
      .findIndex((r) => r !== '');
    // The blank line every closing gets, plus what the form had spare.
    expect(above).toBeGreaterThan(1);
  });

  it('puts the title and the reference on one line', () => {
    const rows = textRows(PAPER_PRESETS.continuous_full)[0] ?? [];
    expect(rows.some((r) => r.startsWith('TANDA TERIMA SERVISAN') && r.endsWith('K7Q-0042'))).toBe(
      true,
    );
  });
});

/** A 21 x 21 QR-sized pattern: a checkerboard, so every band carries ink. */
const LINK: PrintLink = {
  modules: Array.from({ length: 21 }, (_, y) =>
    Array.from({ length: 21 }, (_, x) => (x + y) % 2 === 0),
  ),
  title: 'Cek status servisan',
  address: 'bolusi.id/c/K7M2Q9XA4BRS',
};

/** A page's height in 1/216 inch: text lines at the layout's spacing, pictures by 8-dot band. */
function pageUnits(page: GridPage, linesPerInch: number): number {
  return page.reduce(
    (sum, row) =>
      sum + (row.kind === 'text' ? 216 / linesPerInch : Math.ceil(row.bitmap.height / 8) * 24),
    0,
  );
}

/** The text a band row prints left of its picture. */
const leadText = (row: GridPage[number]): string =>
  row.kind === 'image' ? row.lead.map((span) => span.text).join('') : '';

describe('a link beside the signatures', () => {
  const papers: PaperSettings[] = Object.values(PAPER_PRESETS);

  it('prints the code band by band at the right edge, the signatures and its address beside it', () => {
    const paper = PAPER_PRESETS.continuous_half;
    const { geometry, pages } = layoutGrid(sampleDoc({ link: LINK }), paper);
    expect(pages).toHaveLength(1);
    const bands = (pages[0] ?? []).filter(
      (row): row is Extract<GridPage[number], { kind: 'image' }> => row.kind === 'image',
    );
    const qr = qrBitmap(LINK.modules);
    // Every dot of the code, in order, band after band.
    const printed = bands.flatMap((band) =>
      band.bitmap.width === qr.width ? [...band.bitmap.dots] : [],
    );
    expect(printed).toEqual([...qr.dots]);
    for (const band of bands) {
      expect(band.offset).toBe(geometry.columns - Math.ceil((qr.width / 120) * geometry.pitch));
      expect(leadText(band).length).toBeLessThanOrEqual(band.offset);
    }
    const leads = bands.map(leadText);
    expect(leads.some((lead) => lead.includes('Pelanggan') && lead.includes('Petugas toko'))).toBe(
      true,
    );
    expect(leads.some((lead) => lead.includes('Yohanes Wanimbo'))).toBe(true);
    // A 9-dot character overruns its band by a dot, so the next band leaves those columns blank.
    for (let i = 1; i < leads.length; i += 1) {
      const above = leads[i - 1] ?? '';
      const below = leads[i] ?? '';
      for (let col = 0; col < below.length; col += 1) {
        if (below[col] !== ' ') expect(above[col] ?? ' ', `band ${String(i)}`).toBe(' ');
      }
    }
    const address = bands.find((band) => leadText(band).includes(LINK.address));
    expect(address?.lead.find((span) => span.text.includes(LINK.address))?.bold).toBe(true);
  });

  it.each(papers)('keeps the slip on as many forms as without it ($preset)', (paper) => {
    const without = layoutGrid(sampleDoc(), paper);
    const withLink = layoutGrid(sampleDoc({ link: LINK }), paper);
    expect(withLink.pages).toHaveLength(without.pages.length);
    for (const page of withLink.pages) {
      expect(pageUnits(page, withLink.geometry.linesPerInch)).toBeLessThanOrEqual(
        (withLink.geometry.pageLines - 1) * (216 / withLink.geometry.linesPerInch),
      );
      for (const row of page) {
        if (row.kind === 'text')
          expect(row.text.length).toBeLessThanOrEqual(withLink.geometry.columns);
      }
    }
  });

  it('puts the signatures above it where they would not fit beside', () => {
    const paper: PaperSettings = { ...PAPER_PRESETS.a5, preset: 'custom', widthMm: 100 };
    const { pages } = layoutGrid(sampleDoc({ link: LINK }), paper);
    const rows = pages.flat();
    const firstBand = rows.findIndex((row) => row.kind === 'image');
    const roles = rows.findIndex((row) => row.kind === 'text' && row.text.includes('Pelanggan'));
    expect(roles).toBeGreaterThan(-1);
    expect(roles).toBeLessThan(firstBand);
    expect(
      rows
        .filter((row) => row.kind === 'image')
        .map(leadText)
        .join(' '),
    ).toContain(LINK.address);
  });

  it('is drawn with the address on plain paper', () => {
    const html = renderHtml(sampleDoc({ link: LINK }), PAPER_PRESETS.a4);
    expect(html).toContain('<svg class="qr"');
    expect(html).toContain('bolusi.id/c/K7M2Q9XA4BRS');
    expect(renderHtml(sampleDoc(), PAPER_PRESETS.a4)).not.toContain('<svg');
  });

  it('scales each module to a block of dots', () => {
    const bitmap = qrBitmap([
      [true, false],
      [false, true],
    ]);
    expect(bitmap.width).toBe(2 * QR_MODULE_DOTS.x);
    expect(bitmap.height).toBe(2 * QR_MODULE_DOTS.y);
    expect(bitmap.dots[0]).toBe(1);
    expect(bitmap.dots[QR_MODULE_DOTS.x]).toBe(0);
    expect(bitmap.dots[bitmap.width * bitmap.height - 1]).toBe(1);
  });
});

describe('ESC/P bytes', () => {
  it('sets up the printer, ends every page with a form feed, and sends only ASCII text', () => {
    const paper = PAPER_PRESETS.continuous_full;
    const bytes = renderEscp(
      sampleDoc({ header: { ...sampleDoc().header, name: 'Bolusi Céll' } }),
      paper,
    );
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x78, 0]);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('\x1bC\x42'); // ESC C 66: form length
    expect(text).toContain('Bolusi Cell');
    const pages = layoutGrid(sampleDoc(), paper).pages.length;
    expect(bytes.filter((b) => b === 0x0c).length).toBe(pages);
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
  });

  it('prints a logo as 8-dot column bands', () => {
    // A 2 x 9 dot logo: column 0 all ink, column 1 only the top dot.
    const dots = new Uint8Array(2 * 9);
    for (let y = 0; y < 9; y += 1) dots[y * 2] = 1;
    dots[1] = 1;
    const doc = sampleDoc({
      header: {
        ...sampleDoc().header,
        logo: { dataUri: LOGO_URI, mono: { width: 2, height: 9, dots } },
      },
    });
    const bytes = [...renderEscp(doc, PAPER_PRESETS.continuous_full)];
    const at = bytes.indexOf(0x2a); // '*' of ESC * 1 nL nH
    expect(bytes.slice(at - 1, at + 6)).toEqual([0x1b, 0x2a, 1, 2, 0, 0xff, 0x80]);
    // The second band holds the ninth row: column 0 only.
    const second = bytes.indexOf(0x2a, at + 1);
    expect(bytes.slice(second + 1, second + 6)).toEqual([1, 2, 0, 0x80, 0x00]);
  });

  it('prints a band’s text before its picture, on the same pass', () => {
    const bytes = renderEscp(sampleDoc({ link: LINK }), PAPER_PRESETS.continuous_half);
    const text = new TextDecoder('latin1').decode(bytes);
    // The address in bold, then spaces up to the code, then the code's bit image.
    expect(text).toMatch(/\x1bEbolusi\.id\/c\/K7M2Q9XA4BRS\x1bF *\x1b\*\x01/);
  });
});

describe('HTML', () => {
  it('sizes the page to the paper and gives each copy its own page on plain paper', () => {
    const html = renderHtml(sampleDoc(), PAPER_PRESETS.a5);
    expect(html).toContain('size: 148mm 210mm');
    expect(html.match(/<section class="copy">/g)).toHaveLength(2);
    expect(html).toContain('Untuk pelanggan');
  });

  it('escapes text and only embeds inline images', () => {
    const html = renderHtml(
      sampleDoc({
        title: '<script>alert(1)</script>',
        header: {
          name: 'A & B',
          lines: [],
          logo: { dataUri: 'https://example.com/logo.png', mono: null },
        },
      }),
      PAPER_PRESETS.a4,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).not.toContain('example.com');

    const withLogo = renderHtml(
      sampleDoc({ header: { name: 'A', lines: [], logo: { dataUri: LOGO_URI, mono: null } } }),
      PAPER_PRESETS.a4,
    );
    expect(withLogo).toContain(`src="${LOGO_URI}"`);
  });
});

describe('mono bitmap', () => {
  it('scales to the bit-image resolution and treats transparent pixels as paper', () => {
    // 2 x 1 pixels: opaque black, transparent black.
    const rgba = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]);
    const bitmap = toMonoBitmap(rgba, 2, 1, 2 / 120, 1);
    expect(bitmap.width).toBe(2);
    expect(bitmap.height).toBe(1);
    expect([...bitmap.dots]).toEqual([1, 0]);
  });
});
