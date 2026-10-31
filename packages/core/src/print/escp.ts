// ESC/P bytes for an Epson-compatible dot-matrix printer in text mode.
//
// Only commands from the basic ESC/P set that 9-pin (LX) and 24-pin (LQ) Epsons and their clones all
// accept: reset, draft quality, pitch, 1/6" or 1/8" line spacing, form length, left margin, bold,
// 8-dot bit image and form feed. The desktop app sends these bytes as a RAW job to the installed printer.
import type { PrintDocument } from './document.js';
import { layoutGrid, type GridRow, type GridSpan } from './layout.js';
import type { LinesPerInch, PaperSettings, Pitch } from './paper.js';

const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const FF = 0x0c;
const SI = 0x0f;

const PITCH_BYTES: Readonly<Record<Pitch, readonly number[]>> = {
  10: [ESC, 0x50], // ESC P: pica
  12: [ESC, 0x4d], // ESC M: elite
  17: [ESC, 0x50, SI], // pica + SI: condensed
};

const LINE_SPACING_BYTES: Readonly<Record<LinesPerInch, readonly number[]>> = {
  6: [ESC, 0x32], // ESC 2: 1/6"
  8: [ESC, 0x30], // ESC 0: 1/8"
};

function asciiBytes(text: string, out: number[]): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out.push(code >= 0x20 && code <= 0x7e ? code : 0x3f);
  }
}

function spanBytes(spans: readonly GridSpan[], out: number[]): void {
  for (const span of spans) {
    if (span.bold) out.push(ESC, 0x45); // ESC E
    asciiBytes(span.text, out);
    if (span.bold) out.push(ESC, 0x46); // ESC F
  }
}

/**
 * 8-dot bands, each a column byte per dot (top dot = bit 7), at ESC * 1 (120 dpi), `offset`
 * characters in, after the `lead` text printed on the same pass.
 */
function imageBytes(
  row: Extract<GridRow, { kind: 'image' }>,
  spacing: readonly number[],
  out: number[],
): void {
  const { bitmap, offset, lead } = row;
  const leadLength = lead.reduce((sum, span) => sum + span.text.length, 0);
  out.push(ESC, 0x33, 24); // ESC 3 24: 24/216" = 8 dots per band, so bands touch
  for (let top = 0; top < bitmap.height; top += 8) {
    if (top === 0) spanBytes(lead, out);
    asciiBytes(' '.repeat(Math.max(0, offset - (top === 0 ? leadLength : 0))), out);
    out.push(ESC, 0x2a, 1, bitmap.width & 0xff, (bitmap.width >> 8) & 0xff);
    for (let x = 0; x < bitmap.width; x += 1) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const y = top + bit;
        if (y < bitmap.height && bitmap.dots[y * bitmap.width + x] === 1) byte |= 0x80 >> bit;
      }
      out.push(byte);
    }
    out.push(CR, LF);
  }
  out.push(...spacing); // back to text line spacing
}

function rowBytes(row: GridRow, spacing: readonly number[], out: number[]): void {
  if (row.kind === 'image') {
    imageBytes(row, spacing, out);
    return;
  }
  spanBytes(row.spans, out);
  out.push(CR, LF);
}

/**
 * The document as one print job. Each page ends with a form feed, so the next page (or the next
 * document) starts at the top of the next form, where the paper was lined up.
 */
export function renderEscp(doc: PrintDocument, paper: PaperSettings): Uint8Array {
  const { geometry, pages } = layoutGrid(doc, paper);
  const out: number[] = [ESC, 0x40, ESC, 0x78, 0]; // ESC @ reset, ESC x 0 draft (fast, carbon-friendly)
  out.push(...PITCH_BYTES[geometry.pitch]);
  const spacing = LINE_SPACING_BYTES[geometry.linesPerInch];
  out.push(...spacing);
  out.push(ESC, 0x43, geometry.pageLines); // ESC C n: form length in lines of that spacing
  out.push(ESC, 0x6c, geometry.leftMargin); // ESC l n: left margin in columns
  for (const page of pages) {
    for (const row of page) rowBytes(row, spacing, out);
    out.push(FF);
  }
  out.push(ESC, 0x40);
  return Uint8Array.from(out);
}
