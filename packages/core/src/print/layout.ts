// Lays a document out on a fixed-pitch character grid: the dot-matrix page before it becomes bytes.
// Every decision about what goes where in text mode lives here, so `escp.ts` only encodes, and the
// layout can be read in tests as plain lines.
//
// Every string can be as long as its field allows, so nothing is cut: labels, values, names and
// amounts all wrap inside their own cell. On landscape paper the secondary sections sit in a column
// beside the body; the layout that needs the fewest forms wins.
import type { MonoBitmap } from './bitmap.js';
import type { PrintBlock, PrintDocument, PrintField } from './document.js';
import {
  isLandscape,
  textGeometry,
  type LinesPerInch,
  type PaperSettings,
  type TextGeometry,
} from './paper.js';
import { center, padLeft, padRight, toPrinterAscii, wrapText } from './text.js';

/** A run of characters printed bold or not. */
export interface GridSpan {
  readonly text: string;
  readonly bold: boolean;
}

export type GridRow =
  /** `text` is the whole line; `spans` are the same characters split where bold starts or stops. */
  | { readonly kind: 'text'; readonly text: string; readonly spans: readonly GridSpan[] }
  /** A picture printed `offset` characters in, in 8-dot bands. */
  | { readonly kind: 'image'; readonly bitmap: MonoBitmap; readonly offset: number };

type TextRow = Extract<GridRow, { kind: 'text' }>;

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

/** In 1/216 inch, ESC/P's finest line-feed unit: an image band is 8 dots at 72 dpi. */
const IMAGE_BAND_UNITS = 24;
/** A blank line at the top of each form, so the first line never prints on the perforation. */
const TOP_LINES = 1;
/** A line left blank above each perforation, so nothing prints across the tear. */
const BOTTOM_LINES = 1;
/** At most this many spare lines go above the signatures, to sign in; the rest stays at the foot. */
const MAX_STRETCH_LINES = 3;
/** Characters between side-by-side columns. */
const COLUMN_GAP = 3;
/** Narrower than this and a body column beside an aside gets too cramped to read. */
const MIN_TWO_COLUMN_WIDTH = 76;
/** The body's share of the width beside an aside. */
const BODY_SHARE = 0.56;

function text(value: string, bold = false): TextRow {
  const trimmed = value.replace(/\s+$/, '');
  return { kind: 'text', text: trimmed, spans: trimmed === '' ? [] : [{ text: trimmed, bold }] };
}

const blank = (): TextRow => text('');

/** Text rows laid next to each other, each cell padded to its width. Bold stays per cell. */
function joinCells(cells: readonly { row: TextRow | undefined; width: number }[]): TextRow {
  const spans: GridSpan[] = [];
  const push = (span: GridSpan): void => {
    if (span.text === '') return;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.bold === span.bold) {
      spans[spans.length - 1] = { text: last.text + span.text, bold: span.bold };
    } else {
      spans.push(span);
    }
  };
  cells.forEach(({ row, width }, i) => {
    if (i > 0) push({ text: ' '.repeat(COLUMN_GAP), bold: false });
    for (const span of row?.spans ?? []) push(span);
    const used = row?.text.length ?? 0;
    if (i < cells.length - 1) push({ text: ' '.repeat(Math.max(0, width - used)), bold: false });
  });
  // Trailing spaces print nothing; drop them so a line's length is what it shows.
  while (spans.length > 0) {
    const last = spans[spans.length - 1] as GridSpan;
    const kept = last.text.replace(/\s+$/, '');
    if (kept !== '') {
      spans[spans.length - 1] = { text: kept, bold: last.bold };
      break;
    }
    spans.pop();
  }
  return { kind: 'text', text: spans.map((s) => s.text).join(''), spans };
}

/** Two columns of rows side by side, as long as the longer one. */
function zipColumns(
  left: readonly TextRow[],
  leftWidth: number,
  right: readonly TextRow[],
  rightWidth: number,
): TextRow[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
    joinCells([
      { row: left[i], width: leftWidth },
      { row: right[i], width: rightWidth },
    ]),
  );
}

/** A text line's height in 1/216 inch. */
function lineUnits(geometry: TextGeometry): number {
  return 216 / geometry.linesPerInch;
}

function rowUnits(row: GridRow, line: number): number {
  return row.kind === 'text' ? line : Math.ceil(row.bitmap.height / 8) * IMAGE_BAND_UNITS;
}

function groupUnits(rows: readonly GridRow[], line: number): number {
  return rows.reduce((sum, row) => sum + rowUnits(row, line), 0);
}

/** `left` and `right` on one line when both fit, else `left` wrapped and `right` under it. */
function sideBySide(left: string, right: string, width: number, bold = false): TextRow[] {
  if (right === '') return wrapText(left, width).map((line) => text(line, bold));
  if (left.length + right.length + 2 <= width) {
    return [text(padRight(left, width - right.length) + right, bold)];
  }
  return [
    ...wrapText(left, width).map((line) => text(line, bold)),
    ...wrapText(right, width).map((line) => text(padLeft(line, width), bold)),
  ];
}

/** A label and its value, each wrapping in its own column: `Label : value`. */
function fieldLines(field: PrintField, labelWidth: number, width: number): string[] {
  const valueWidth = Math.max(8, width - labelWidth - 3);
  const labels = wrapText(field.label, labelWidth);
  const values = wrapText(field.value, valueWidth);
  return Array.from(
    { length: Math.max(labels.length, values.length) },
    (_, i) =>
      `${padRight(labels[i] ?? '', labelWidth)}${i === 0 ? ' : ' : '   '}${values[i] ?? ''}`,
  );
}

function fieldRows(fields: readonly PrintField[], width: number): TextRow[] {
  const longest = fields.reduce((max, f) => Math.max(max, f.label.length), 0);
  const twoColumns = width >= 72 && fields.length > 1;
  const colWidth = twoColumns ? Math.floor((width - COLUMN_GAP) / 2) : width;
  // Labels are short words; a label longer than this wraps rather than squeezing the value. A
  // half-line column has room for a shorter one than a full line does.
  const labelWidthFor = (cap: number): number =>
    Math.max(1, Math.min(longest, cap, Math.floor(width / 3)));
  // Paired only when every value fits half a line, so the labels line up down the block.
  const paired =
    twoColumns && fields.every((f) => f.value.length <= colWidth - labelWidthFor(13) - 3);
  const labelWidth = labelWidthFor(paired ? 13 : 18);
  const rows: TextRow[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as PrintField;
    const next = fields[i + 1];
    if (next !== undefined && paired) {
      const left = fieldLines(field, labelWidth, colWidth).map((line) => text(line));
      const right = fieldLines(next, labelWidth, colWidth).map((line) => text(line));
      rows.push(...zipColumns(left, colWidth, right, colWidth));
      i += 1;
    } else {
      for (const line of fieldLines(field, labelWidth, width)) rows.push(text(line));
    }
  }
  return rows;
}

/**
 * Items packed into up to three columns, filled across then down, when most of them fit a column;
 * an item longer than its column wraps inside it.
 */
function listRows(items: readonly string[], width: number): TextRow[] {
  const bulleted = (item: string, cellWidth: number): TextRow[] =>
    wrapText(item, cellWidth - 2).map((line, i) => text(`${i === 0 ? '- ' : '  '}${line}`));
  const colWidth = (columns: number): number =>
    Math.floor((width - (columns - 1) * COLUMN_GAP) / columns);
  const columns =
    [3, 2].find(
      (count) =>
        colWidth(count) >= 12 &&
        items.length >= count &&
        items.filter((item) => item.length + 2 <= colWidth(count)).length >= items.length * 0.75,
    ) ?? 1;
  if (columns === 1) return items.flatMap((item) => bulleted(item, width));
  const cellWidth = colWidth(columns);
  const rows: TextRow[] = [];
  for (let i = 0; i < items.length; i += columns) {
    const cells = items.slice(i, i + columns).map((item) => bulleted(item, cellWidth));
    const height = Math.max(...cells.map((lines) => lines.length));
    for (let line = 0; line < height; line += 1) {
      rows.push(joinCells(cells.map((lines) => ({ row: lines[line], width: cellWidth }))));
    }
  }
  return rows;
}

function termRows(items: readonly string[], width: number): TextRow[] {
  const numberWidth = `${items.length}.`.length + 1;
  return items.flatMap((item, n) =>
    wrapText(item, width - numberWidth).map((line, i) =>
      text(`${padRight(i === 0 ? `${n + 1}.` : '', numberWidth)}${line}`),
    ),
  );
}

function amountRows(block: Extract<PrintBlock, { kind: 'amounts' }>, width: number): TextRow[] {
  // An amount keeps to one line where it can: it is what the customer pays. Its label wraps.
  const amountWidth = Math.min(
    width - 8,
    [...block.rows, ...block.totals].reduce((max, row) => Math.max(max, row.amount.length), 0),
  );
  const labelWidth = width - amountWidth - 2;
  const priced = (
    label: string,
    amount: string,
    strong: boolean,
    alignRight: boolean,
  ): TextRow[] => {
    const labels = wrapText(label, labelWidth);
    const amounts = wrapText(amount, amountWidth);
    return Array.from({ length: Math.max(labels.length, amounts.length) }, (_, i) => {
      const line = labels[i] ?? '';
      return text(
        `${alignRight ? padLeft(line, labelWidth) : padRight(line, labelWidth)}  ${padLeft(
          amounts[i] ?? '',
          amountWidth,
        )}`,
        strong,
      );
    });
  };
  const rows: TextRow[] = block.rows.flatMap((row) =>
    priced(row.label, row.amount, row.strong === true, false),
  );
  if (block.totals.length > 0) {
    if (block.rows.length > 0) rows.push(text(padLeft('-'.repeat(amountWidth + 2), width)));
    for (const total of block.totals) {
      rows.push(...priced(total.label, total.amount, total.strong === true, true));
    }
  }
  return rows;
}

/** Each cell's lines centred in its slot, slots side by side. */
function centredCells(cells: readonly string[], slotWidth: number, gap: number): TextRow[] {
  const wrapped = cells.map((cell) => (cell === '' ? [] : wrapText(cell, slotWidth)));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  return Array.from({ length: height }, (_, i) =>
    text(wrapped.map((lines) => center(lines[i] ?? '', slotWidth)).join(' '.repeat(gap))),
  );
}

function signatureRows(
  block: Extract<PrintBlock, { kind: 'signatures' }>,
  width: number,
  compact: boolean,
): TextRow[] {
  const count = Math.max(1, block.slots.length);
  const gap = 4;
  const slotWidth = Math.max(1, Math.floor((width - (count - 1) * gap) / count));
  // Room to sign: three lines (half an inch), two when squeezing onto one form.
  const space = Array.from({ length: compact ? 2 : 3 }, blank);
  return [
    ...centredCells(
      block.slots.map((slot) => slot.role),
      slotWidth,
      gap,
    ),
    ...space,
    ...centredCells(
      block.slots.map(() => '_'.repeat(Math.max(4, slotWidth - 4))),
      slotWidth,
      gap,
    ),
    ...centredCells(
      block.slots.map((slot) => slot.name ?? ''),
      slotWidth,
      gap,
    ),
  ];
}

/** Column numbers across the printable width: shows at a glance whether the paper is set right. */
function rulerRows(caption: string, width: number): TextRow[] {
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
  const flowing = (rows: GridRow[]): Group => ({ rows, keepTogether: false, keepWithNext: false });
  switch (block.kind) {
    case 'heading':
      return {
        rows: wrapText(block.text.toUpperCase(), width).map((line) => text(line, true)),
        keepTogether: true,
        keepWithNext: true,
      };
    case 'fields':
      return flowing(fieldRows(block.fields, width));
    case 'paragraph':
      return flowing(wrapText(block.text, width).map((line) => text(line)));
    case 'list':
      return flowing(listRows(block.items, width));
    case 'terms':
      return flowing(termRows(block.items, width));
    case 'amounts':
      return flowing(amountRows(block, width));
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

/** A run of blocks, with a blank line between them except right after a heading. */
function blockGroups(blocks: readonly PrintBlock[], width: number, compact: boolean): Group[] {
  return blocks.map((block, i) => {
    const group = blockGroup(block, width, compact);
    const prev = blocks[i - 1];
    const gap = !compact && i > 0 && prev?.kind !== 'heading';
    return gap ? { ...group, rows: [blank(), ...group.rows] } : group;
  });
}

/** A column's rows; the blocks never lay out to images, so every row is text. */
function columnRows(blocks: readonly PrintBlock[], width: number, compact: boolean): TextRow[] {
  return blockGroups(blocks, width, compact).flatMap((group) =>
    group.rows.filter((row): row is TextRow => row.kind === 'text'),
  );
}

/** Every string a printer will see, in printer-safe ASCII. */
function asciiBlock(block: PrintBlock): PrintBlock {
  const a = (value: string, keepLineBreaks = false): string =>
    toPrinterAscii(value, keepLineBreaks);
  switch (block.kind) {
    case 'heading':
      return { ...block, text: a(block.text) };
    case 'paragraph':
      return { ...block, text: a(block.text, true) };
    case 'fields':
      return {
        ...block,
        fields: block.fields.map((f) => ({ label: a(f.label), value: a(f.value) })),
      };
    case 'list':
    case 'terms':
      return { ...block, items: block.items.map((item) => a(item)) };
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
}

function asciiDocument(doc: PrintDocument): PrintDocument {
  const a = (value: string): string => toPrinterAscii(value);
  return {
    ...doc,
    header: { ...doc.header, name: a(doc.header.name), lines: doc.header.lines.map(a) },
    title: a(doc.title),
    reference: a(doc.reference),
    meta: doc.meta.map(a),
    copies: doc.copies.map(a),
    plyNote: doc.plyNote === null ? null : a(doc.plyNote),
    footer: doc.footer === null ? null : a(doc.footer),
    blocks: doc.blocks.map(asciiBlock),
    aside: doc.aside.map(asciiBlock),
    closing: doc.closing.map(asciiBlock),
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
  for (const line of wrapText(doc.header.name, width)) rows.push(text(center(line, width), true));
  // Short address and contact lines share one line, to leave the form's height for the slip.
  const joined = doc.header.lines.join('  |  ');
  for (const line of joined.length <= width ? [joined] : doc.header.lines) {
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
  const [left = '', right = ''] = [doc.footer, carbonless ? doc.plyNote : null].filter(
    (line): line is string => line !== null && line !== '',
  );
  if (left === '') return null;
  return {
    rows: [
      blank(),
      ...(compact ? [] : [text('-'.repeat(width))]),
      ...sideBySide(left, right, width),
    ],
    keepTogether: true,
    keepWithNext: false,
  };
}

/** Room on one form for rows, in 1/216 inch. */
function pageCapacity(geometry: TextGeometry): number {
  return (geometry.pageLines - BOTTOM_LINES) * lineUnits(geometry);
}

/** Fill pages with groups, breaking only where the groups allow. */
function paginate(groups: readonly Group[], geometry: TextGeometry, reference: string): GridPage[] {
  const line = lineUnits(geometry);
  const capacity = pageCapacity(geometry);
  const top = (): GridRow[] => Array.from({ length: TOP_LINES }, blank);
  const pages: GridRow[][] = [top()];
  let used = TOP_LINES * line;
  const newPage = (): void => {
    const marker = text(padLeft(`${reference} (${pages.length + 1})`, geometry.columns));
    pages.push([...top(), marker, blank()]);
    used = (TOP_LINES + 2) * line;
  };
  const place = (row: GridRow): void => {
    if (used + rowUnits(row, line) > capacity && used > (TOP_LINES + 2) * line) newPage();
    (pages[pages.length - 1] as GridRow[]).push(row);
    used += rowUnits(row, line);
  };
  groups.forEach((group, i) => {
    const units = groupUnits(group.rows, line);
    const next = groups[i + 1];
    // A heading also needs room for the first two rows of what follows it.
    const needed =
      group.keepWithNext && next !== undefined
        ? units + groupUnits(next.rows.slice(0, 2), line)
        : group.keepTogether
          ? units
          : groupUnits(group.rows.slice(0, 1), line);
    const fresh = (TOP_LINES + 2) * line;
    if (used + needed > capacity && needed <= capacity - fresh && used > TOP_LINES * line) {
      newPage();
    }
    group.rows.forEach(place);
  });
  return pages;
}

interface Variant {
  readonly linesPerInch: LinesPerInch;
  /** The aside in a column beside the body. */
  readonly sideBySide: boolean;
  /**
   * The signatures under the aside rather than under everything. Only taken when it makes the
   * paper one form: on a longer document they belong at its end.
   */
  readonly closingBeside: boolean;
  /** No blank lines between sections and less signing room. */
  readonly compact: boolean;
}

/** The groups that make up a copy: what reads top down, then what sits at its foot. */
interface CopyGroups {
  readonly content: Group[];
  /** The signatures (when not beside the aside) and the footer: spare lines go above these. */
  readonly foot: Group[];
}

/** The closing blocks full width, a blank line above them even when compact: room to sign. */
function closingGroups(doc: PrintDocument, width: number, compact: boolean): Group[] {
  return blockGroups(doc.closing, width, compact).map((group, i) =>
    i > 0 ? group : { ...group, rows: [blank(), ...group.rows] },
  );
}

/**
 * The body and aside as columns, the closing (signatures) full width underneath, or at the foot of
 * the aside column when `closingBeside` and the aside still ends above the body.
 *
 * When the aside runs much longer than the body, its trailing sections (the terms, say) move under
 * the body instead, wherever that makes the columns shortest.
 */
function columnGroups(
  doc: PrintDocument,
  width: number,
  compact: boolean,
  closingBeside: boolean,
): CopyGroups {
  const bodyWidth = Math.floor((width - COLUMN_GAP) * BODY_SHARE);
  const asideWidth = width - COLUMN_GAP - bodyWidth;
  let best: { body: TextRow[]; aside: TextRow[] } | null = null;
  for (let cut = doc.aside.length; cut > 0; cut -= 1) {
    // A heading stays with the section it names.
    if (cut < doc.aside.length && doc.aside[cut - 1]?.kind === 'heading') continue;
    const body = columnRows([...doc.blocks, ...doc.aside.slice(cut)], bodyWidth, compact);
    const aside = columnRows(doc.aside.slice(0, cut), asideWidth, compact);
    const height = Math.max(body.length, aside.length);
    if (best === null || height < Math.max(best.body.length, best.aside.length)) {
      best = { body, aside };
    }
  }
  const { body, aside } = best ?? {
    body: columnRows(doc.blocks, bodyWidth, compact),
    aside: [],
  };
  const beside = [blank(), ...columnRows(doc.closing, asideWidth, compact)];
  const fitsBeside =
    closingBeside && doc.closing.length > 0 && aside.length + beside.length <= body.length;
  const columns: Group = {
    rows: zipColumns(body, bodyWidth, fitsBeside ? [...aside, ...beside] : aside, asideWidth),
    keepTogether: false,
    keepWithNext: false,
  };
  if (fitsBeside) return { content: [columns], foot: [] };
  return { content: [columns], foot: closingGroups(doc, width, compact) };
}

/** Up to `MAX_STRETCH_LINES` blank lines above the foot, from what a one-form copy leaves spare. */
function stretchFoot(
  copy: CopyGroups,
  geometry: TextGeometry,
  pages: readonly GridPage[],
): Group[] | null {
  const [first, ...rest] = copy.foot;
  if (pages.length !== 1 || first === undefined) return null;
  const line = lineUnits(geometry);
  const used = groupUnits(pages[0] as GridPage, line);
  const spare = Math.min(MAX_STRETCH_LINES, Math.floor((pageCapacity(geometry) - used) / line));
  if (spare <= 0) return null;
  const stretched = { ...first, rows: [...Array.from({ length: spare }, blank), ...first.rows] };
  return [...copy.content, stretched, ...rest];
}

function layoutCopy(
  doc: PrintDocument,
  copy: string | null,
  paper: PaperSettings,
  variant: Variant,
): GridPage[] {
  const geometry = textGeometry(paper, variant.linesPerInch);
  const width = geometry.columns;
  const { compact } = variant;
  const header = headerGroup(doc, copy, geometry);
  // Stacked: the aside continues the body as more blocks, the closing under it.
  const body: CopyGroups = variant.sideBySide
    ? columnGroups(doc, width, compact, variant.closingBeside)
    : {
        content: blockGroups([...doc.blocks, ...doc.aside], width, compact),
        foot: closingGroups(doc, width, compact),
      };
  const footer = footerGroup(doc, paper.carbonless, width, compact);
  const groups: CopyGroups = {
    content: [header, ...body.content],
    foot: footer === null ? body.foot : [...body.foot, footer],
  };
  const pages = paginate([...groups.content, ...groups.foot], geometry, doc.reference);
  const stretched = stretchFoot(groups, geometry, pages);
  return stretched === null ? pages : paginate(stretched, geometry, doc.reference);
}

/**
 * The document on the paper's character grid, one run of pages per copy (one on carbonless).
 *
 * Paper the customer carries home should be one sheet, so layouts are tried roomiest first and the
 * first that needs the fewest forms wins. On landscape paper wide enough, the aside goes beside the
 * body, else everything is stacked; each first with blank lines between sections, then without;
 * then the same with the signatures under the aside; all at 6 lines per inch, then at 8. Spare
 * lines on a one-form slip go above the signatures.
 */
export function layoutGrid(source: PrintDocument, paper: PaperSettings): GridLayout {
  const doc = asciiDocument(source);
  const columnsFit =
    isLandscape(paper) &&
    doc.aside.length > 0 &&
    textGeometry(paper).columns >= MIN_TWO_COLUMN_WIDTH;
  const arrangements: Pick<Variant, 'sideBySide' | 'closingBeside'>[] = [
    ...(columnsFit
      ? [
          { sideBySide: true, closingBeside: false },
          { sideBySide: true, closingBeside: true },
        ]
      : []),
    { sideBySide: false, closingBeside: false },
  ];
  // Signatures squeezed beside the aside get short lines, so tighter spacing is tried first.
  const variants: Variant[] = ([6, 8] as const).flatMap((linesPerInch) =>
    [false, true].flatMap((beside) =>
      [false, true].flatMap((compact) =>
        arrangements
          .filter((arrangement) => arrangement.closingBeside === beside)
          .map((arrangement) => ({ ...arrangement, linesPerInch, compact })),
      ),
    ),
  );
  const copies: (string | null)[] =
    paper.carbonless || doc.copies.length === 0 ? [null] : [...doc.copies];
  // Every copy uses the layout the first one needed, so the job keeps one line spacing.
  let best: { variant: Variant; pages: GridPage[] } | null = null;
  for (const variant of variants) {
    const pages = layoutCopy(doc, copies[0] ?? null, paper, variant);
    if (variant.closingBeside && pages.length > 1) continue;
    if (best === null || pages.length < best.pages.length) best = { variant, pages };
    if (best.pages.length === 1) break;
  }
  const chosen = (best as { variant: Variant }).variant;
  return {
    geometry: textGeometry(paper, chosen.linesPerInch),
    pages: copies.flatMap((copy) => layoutCopy(doc, copy, paper, chosen)),
  };
}
