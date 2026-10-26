// Lays a document out on a fixed-pitch character grid: the dot-matrix page before it becomes bytes.
// Every decision about what goes where in text mode lives here, so `escp.ts` only encodes, and the
// layout can be read in tests as plain lines.
import type { MonoBitmap } from './bitmap.js';
import type { PrintBlock, PrintDocument, PrintField } from './document.js';
import { textGeometry, type PaperSettings, type TextGeometry } from './paper.js';
import { center, padLeft, padRight, toPrinterAscii, wrapText } from './text.js';

export type GridRow =
  | { readonly kind: 'text'; readonly text: string; readonly bold: boolean }
  /** A picture printed `offset` characters in, in 8-dot bands. */
  | { readonly kind: 'image'; readonly bitmap: MonoBitmap; readonly offset: number };

/** One printed sheet (one perforated form on continuous paper). */
export type GridPage = readonly GridRow[];

export interface GridLayout {
  readonly geometry: TextGeometry;
  /** Every copy's pages, in print order. */
  readonly pages: readonly GridPage[];
}

/** Rows a block lays out to, and whether a page break may fall inside it. */
interface Group {
  readonly rows: readonly GridRow[];
  readonly keepTogether: boolean;
  /** A heading: never last on a page, so it moves with the start of what it names. */
  readonly keepWithNext: boolean;
}

/** In 1/216 inch, ESC/P's finest line-feed unit: a text line is 1/6", an image band 8 dots at 72 dpi. */
const TEXT_ROW_UNITS = 36;
const IMAGE_BAND_UNITS = 24;
/** Lines left blank above each perforation, so nothing prints across the tear. */
const BOTTOM_LINES = 2;
const BLOCK_GAP: GridRow = text('');

function text(value: string, bold = false): GridRow {
  return { kind: 'text', text: value.replace(/\s+$/, ''), bold };
}

function rowUnits(row: GridRow): number {
  return row.kind === 'text' ? TEXT_ROW_UNITS : Math.ceil(row.bitmap.height / 8) * IMAGE_BAND_UNITS;
}

function groupUnits(rows: readonly GridRow[]): number {
  return rows.reduce((sum, row) => sum + rowUnits(row), 0);
}

/** `left` and `right` on one line when both fit, else on two. */
function sideBySide(left: string, right: string, width: number, bold = false): GridRow[] {
  if (right === '') return wrapText(left, width).map((line) => text(line, bold));
  if (left.length + right.length + 2 <= width) {
    return [text(padRight(left, width - right.length) + right, bold)];
  }
  return [
    ...wrapText(left, width).map((line) => text(line, bold)),
    text(padLeft(right, width), bold),
  ];
}

function fieldLines(field: PrintField, labelWidth: number, width: number): string[] {
  const valueWidth = Math.max(8, width - labelWidth - 3);
  return wrapText(field.value, valueWidth).map((line, i) =>
    i === 0
      ? `${padRight(field.label, labelWidth)} : ${line}`
      : `${' '.repeat(labelWidth + 3)}${line}`,
  );
}

function fieldRows(fields: readonly PrintField[], width: number): GridRow[] {
  const longest = fields.reduce((max, f) => Math.max(max, f.label.length), 0);
  const twoColumns = width >= 72 && fields.length > 1;
  const colWidth = twoColumns ? Math.floor((width - 3) / 2) : width;
  const labelWidth = Math.min(longest, twoColumns ? 13 : 16);
  const fitsHalf = (f: PrintField): boolean =>
    twoColumns && f.value.length <= colWidth - labelWidth - 3;
  const rows: GridRow[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as PrintField;
    const next = fields[i + 1];
    if (next !== undefined && fitsHalf(field) && fitsHalf(next)) {
      const left = fieldLines(field, labelWidth, colWidth);
      const right = fieldLines(next, labelWidth, colWidth);
      left.forEach((line, j) => rows.push(text(`${padRight(line, colWidth)}   ${right[j] ?? ''}`)));
      i += 1;
    } else {
      for (const line of fieldLines(field, labelWidth, width)) rows.push(text(line));
    }
  }
  return rows;
}

/** Short items packed into up to three columns, filled across then down. */
function listRows(items: readonly string[], width: number): GridRow[] {
  const longest = items.reduce((max, item) => Math.max(max, item.length + 2), 0);
  const columns = Math.max(1, Math.min(3, Math.floor((width + 3) / (longest + 3))));
  if (columns === 1) {
    return items.flatMap((item) =>
      wrapText(item, width - 2).map((line, i) => text(`${i === 0 ? '- ' : '  '}${line}`)),
    );
  }
  const colWidth = Math.floor((width - (columns - 1) * 3) / columns);
  const rows: GridRow[] = [];
  for (let i = 0; i < items.length; i += columns) {
    const cells = items.slice(i, i + columns).map((item) => padRight(`- ${item}`, colWidth));
    rows.push(text(cells.join('   ')));
  }
  return rows;
}

function termRows(items: readonly string[], width: number): GridRow[] {
  const numberWidth = `${items.length}.`.length + 1;
  return items.flatMap((item, n) =>
    wrapText(item, width - numberWidth).map((line, i) =>
      text(`${padRight(i === 0 ? `${n + 1}.` : '', numberWidth)}${line}`),
    ),
  );
}

function amountRows(block: Extract<PrintBlock, { kind: 'amounts' }>, width: number): GridRow[] {
  const amountWidth = [...block.rows, ...block.totals].reduce(
    (max, row) => Math.max(max, row.amount.length),
    0,
  );
  const labelWidth = width - amountWidth - 2;
  const rows: GridRow[] = [];
  for (const row of block.rows) {
    wrapText(row.label, labelWidth).forEach((line, i) =>
      rows.push(
        text(
          `${padRight(line, labelWidth)}  ${i === 0 ? padLeft(row.amount, amountWidth) : ''}`,
          row.strong === true,
        ),
      ),
    );
  }
  if (block.totals.length > 0) {
    if (block.rows.length > 0) rows.push(text(padLeft('-'.repeat(amountWidth + 2), width)));
    for (const total of block.totals) {
      rows.push(
        text(
          `${padLeft(total.label, labelWidth)}  ${padLeft(total.amount, amountWidth)}`,
          total.strong === true,
        ),
      );
    }
  }
  return rows;
}

function signatureRows(
  block: Extract<PrintBlock, { kind: 'signatures' }>,
  width: number,
  compact: boolean,
): GridRow[] {
  const count = Math.max(1, block.slots.length);
  const gap = 4;
  const slotWidth = Math.floor((width - (count - 1) * gap) / count);
  const line = (cells: readonly string[]): GridRow =>
    text(cells.map((cell) => center(cell, slotWidth)).join(' '.repeat(gap)));
  // Room to sign: three lines (half an inch), two when squeezing onto one form.
  const space = Array.from({ length: compact ? 2 : 3 }, () => line([]));
  return [
    line(block.slots.map((slot) => slot.role)),
    ...space,
    line(block.slots.map(() => '_'.repeat(Math.max(4, slotWidth - 4)))),
    line(block.slots.map((slot) => slot.name ?? '')),
  ];
}

/** Column numbers across the printable width: shows at a glance whether the paper is set right. */
function rulerRows(caption: string, width: number): GridRow[] {
  let digits = '';
  let tens = '';
  for (let col = 1; col <= width; col += 1) {
    digits += String(col % 10);
    tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : col === 1 ? '|' : ' ';
  }
  return [
    text(tens),
    text(digits),
    text(`${'<'.repeat(Math.min(3, width))}${padLeft('>'.repeat(Math.min(3, width)), width - 3)}`),
    ...wrapText(caption, width).map((value) => text(value)),
  ];
}

function blockGroup(block: PrintBlock, width: number, compact: boolean): Group {
  switch (block.kind) {
    case 'heading':
      return {
        rows: [text(block.text.toUpperCase(), true)],
        keepTogether: true,
        keepWithNext: true,
      };
    case 'fields':
      return { rows: fieldRows(block.fields, width), keepTogether: false, keepWithNext: false };
    case 'paragraph':
      return {
        rows: wrapText(block.text, width).map((line) => text(line)),
        keepTogether: false,
        keepWithNext: false,
      };
    case 'list':
      return { rows: listRows(block.items, width), keepTogether: false, keepWithNext: false };
    case 'terms':
      return { rows: termRows(block.items, width), keepTogether: false, keepWithNext: false };
    case 'amounts':
      return { rows: amountRows(block, width), keepTogether: false, keepWithNext: false };
    case 'signatures':
      return {
        rows: signatureRows(block, width, compact),
        keepTogether: true,
        keepWithNext: false,
      };
    case 'ruler':
      return { rows: rulerRows(block.caption, width), keepTogether: true, keepWithNext: false };
  }
}

/** Every string a printer will see, in printer-safe ASCII. */
function asciiDocument(doc: PrintDocument): PrintDocument {
  const a = toPrinterAscii;
  return {
    ...doc,
    header: { ...doc.header, name: a(doc.header.name), lines: doc.header.lines.map(a) },
    title: a(doc.title),
    reference: a(doc.reference),
    meta: doc.meta.map(a),
    copies: doc.copies.map(a),
    plyNote: doc.plyNote === null ? null : a(doc.plyNote),
    footer: doc.footer === null ? null : a(doc.footer),
    blocks: doc.blocks.map((block): PrintBlock => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return { ...block, text: a(block.text) };
        case 'fields':
          return {
            ...block,
            fields: block.fields.map((f) => ({ label: a(f.label), value: a(f.value) })),
          };
        case 'list':
        case 'terms':
          return { ...block, items: block.items.map(a) };
        case 'amounts':
          return {
            ...block,
            rows: block.rows.map((r) => ({ ...r, label: a(r.label), amount: a(r.amount) })),
            totals: block.totals.map((r) => ({ ...r, label: a(r.label), amount: a(r.amount) })),
          };
        case 'signatures':
          return {
            ...block,
            slots: block.slots.map((s) => ({
              ...s,
              role: a(s.role),
              name: s.name === null ? null : a(s.name),
            })),
          };
        case 'ruler':
          return { ...block, caption: a(block.caption) };
      }
    }),
  };
}

function headerGroup(doc: PrintDocument, copy: string | null, geometry: TextGeometry): Group {
  const width = geometry.columns;
  const rows: GridRow[] = [];
  const logo = doc.header.logo?.mono ?? null;
  // A logo wider than the line is left out rather than wrapped onto the next band.
  const logoCols = logo === null ? 0 : Math.ceil((logo.width / 120) * geometry.pitch);
  if (logo !== null && logoCols <= width) {
    rows.push({ kind: 'image', bitmap: logo, offset: Math.floor((width - logoCols) / 2) });
  }
  rows.push(text(center(doc.header.name, width), true));
  for (const line of doc.header.lines) {
    for (const wrapped of wrapText(line, width)) rows.push(text(center(wrapped, width)));
  }
  rows.push(text('='.repeat(width)));
  rows.push(...sideBySide(doc.title, doc.reference, width, true));
  rows.push(...sideBySide(doc.meta.join('  |  '), copy ?? '', width));
  rows.push(text('-'.repeat(width)));
  return { rows, keepTogether: true, keepWithNext: true };
}

function footerGroup(
  doc: PrintDocument,
  carbonless: boolean,
  width: number,
  compact: boolean,
): Group | null {
  const notes = [doc.footer, carbonless ? doc.plyNote : null].filter(
    (line): line is string => line !== null && line !== '',
  );
  if (notes.length === 0) return null;
  const lines = compact ? [notes.join('. ')] : notes;
  return {
    rows: [
      ...(compact ? [] : [text('-'.repeat(width))]),
      ...lines.flatMap((line) => wrapText(line, width).map((l) => text(l))),
    ],
    keepTogether: true,
    keepWithNext: false,
  };
}

/** Fill pages with groups, breaking only where the groups allow. */
function paginate(groups: readonly Group[], geometry: TextGeometry, reference: string): GridPage[] {
  const capacity = (geometry.pageLines - BOTTOM_LINES) * TEXT_ROW_UNITS;
  const pages: GridRow[][] = [[]];
  let used = 0;
  const newPage = (): void => {
    pages.push([]);
    const marker = text(padLeft(`${reference} (${pages.length})`, geometry.columns));
    (pages[pages.length - 1] as GridRow[]).push(marker, BLOCK_GAP);
    used = 2 * TEXT_ROW_UNITS;
  };
  const place = (row: GridRow): void => {
    if (used + rowUnits(row) > capacity && used > 2 * TEXT_ROW_UNITS) newPage();
    (pages[pages.length - 1] as GridRow[]).push(row);
    used += rowUnits(row);
  };
  groups.forEach((group, i) => {
    const units = groupUnits(group.rows);
    const next = groups[i + 1];
    // A heading also needs room for the first two rows of what follows it.
    const needed =
      group.keepWithNext && next !== undefined
        ? units + groupUnits(next.rows.slice(0, 2))
        : group.keepTogether
          ? units
          : groupUnits(group.rows.slice(0, 1));
    if (used + needed > capacity && needed <= capacity - 2 * TEXT_ROW_UNITS && used > 0) newPage();
    group.rows.forEach(place);
  });
  return pages;
}

function layoutCopy(
  doc: PrintDocument,
  copy: string | null,
  paper: PaperSettings,
  geometry: TextGeometry,
  compact: boolean,
): GridPage[] {
  const width = geometry.columns;
  const gap = compact ? [] : [BLOCK_GAP];
  const groups: Group[] = [headerGroup(doc, copy, geometry)];
  doc.blocks.forEach((block, i) => {
    const group = blockGroup(block, width, compact);
    // A blank line between blocks, except right after a heading.
    const prev = doc.blocks[i - 1];
    groups.push({
      ...group,
      rows: [...(i > 0 && prev?.kind !== 'heading' ? gap : []), ...group.rows],
    });
  });
  const footer = footerGroup(doc, paper.carbonless, width, compact);
  if (footer !== null) groups.push({ ...footer, rows: [BLOCK_GAP, ...footer.rows] });
  return paginate(groups, geometry, doc.reference);
}

/**
 * The document on the paper's character grid, one run of pages per copy (one on carbonless). When
 * the roomy layout spills onto another form, a tighter one (no blank lines between sections, less
 * signing room) is used if it needs fewer forms: paper the customer carries home should be one sheet.
 */
export function layoutGrid(source: PrintDocument, paper: PaperSettings): GridLayout {
  const doc = asciiDocument(source);
  const geometry = textGeometry(paper);
  const copies: (string | null)[] =
    paper.carbonless || doc.copies.length === 0 ? [null] : [...doc.copies];
  const pages = copies.flatMap((copy) => {
    const roomy = layoutCopy(doc, copy, paper, geometry, false);
    if (roomy.length === 1) return roomy;
    const compact = layoutCopy(doc, copy, paper, geometry, true);
    return compact.length < roomy.length ? compact : roomy;
  });
  return { geometry, pages };
}
