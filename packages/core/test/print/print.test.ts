import { describe, expect, it } from 'vitest';

import {
  PAPER_PRESETS,
  layoutGrid,
  renderEscp,
  renderHtml,
  textGeometry,
  toMonoBitmap,
  toPrinterAscii,
  wrapText,
  type PaperSettings,
  type PrintDocument,
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
      {
        kind: 'amounts',
        rows: [
          { label: 'Ganti LCD', amount: 'Rp 850.000' },
          { label: 'Jasa', amount: 'Rp 100.000' },
        ],
        totals: [{ label: 'Estimasi total', amount: 'Rp 950.000', strong: true }],
      },
      { kind: 'terms', items: ['Bawa nota ini saat mengambil HP.', 'Biaya masih perkiraan.'] },
      {
        kind: 'signatures',
        slots: [
          { role: 'Pelanggan', name: 'Yohanes Wanimbo', image: null },
          { role: 'Petugas toko', name: null, image: null },
        ],
      },
    ],
    copies: ['Untuk toko', 'Untuk pelanggan'],
    plyNote: 'Lembar merah muda untuk toko, lembar kuning untuk pelanggan.',
    footer: 'Dicetak 26/10/2026 14.31 oleh Maria',
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
      pageLines: 66,
    });
    expect(textGeometry(PAPER_PRESETS.continuous_half).pageLines).toBe(33);
  });

  it('switches to a smaller pitch on narrow paper so a line still holds labels and amounts', () => {
    expect(textGeometry(PAPER_PRESETS.a5).pitch).toBe(12);
    const narrow = textGeometry({ ...PAPER_PRESETS.a5, preset: 'custom', widthMm: 100 });
    expect(narrow.pitch).toBe(17);
    expect(narrow.columns).toBeGreaterThanOrEqual(56);
  });
});

describe('text-mode layout', () => {
  const papers = [
    PAPER_PRESETS.continuous_full,
    PAPER_PRESETS.continuous_half,
    PAPER_PRESETS.a4,
    PAPER_PRESETS.a5,
    { ...PAPER_PRESETS.a5, preset: 'custom' as const, widthMm: 80, heightMm: 120 },
  ];

  it.each(papers)(
    'never prints past the line or below the perforation ($preset, $widthMm mm)',
    (paper) => {
      const { geometry, pages } = layoutGrid(sampleDoc(), paper);
      for (const page of pages) {
        expect(page.length).toBeLessThanOrEqual(geometry.pageLines - 2);
        for (const row of page)
          if (row.kind === 'text') expect(row.text.length).toBeLessThanOrEqual(geometry.columns);
      }
    },
  );

  it('prints once with the ply note on carbonless paper, and a labelled copy each on plain paper', () => {
    const carbon = textRows(PAPER_PRESETS.continuous_full).flat().join('\n');
    expect(carbon).toContain('Lembar merah muda untuk toko');
    expect(carbon).not.toContain('Untuk pelanggan');

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
    expect(pages[1]?.[0]).toMatch(/K7Q-0042 \(2\)$/);
  });

  it('puts the title and the reference on one line', () => {
    const rows = textRows(PAPER_PRESETS.continuous_full)[0] ?? [];
    expect(rows.some((r) => r.startsWith('TANDA TERIMA SERVISAN') && r.endsWith('K7Q-0042'))).toBe(
      true,
    );
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
