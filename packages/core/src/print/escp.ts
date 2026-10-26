// ESC/P bytes for an Epson-compatible dot-matrix printer in text mode.
//
// Only commands from the basic ESC/P set that 9-pin (LX) and 24-pin (LQ) Epsons and their clones all
// accept: reset, draft quality, pitch, 1/6" line spacing, form length, left margin, bold, 8-dot bit
// image and form feed. The desktop app sends these bytes as a RAW job to the installed printer.
import type { MonoBitmap } from './bitmap.js';
import type { PrintDocument } from './document.js';
import { layoutGrid, type GridRow } from './layout.js';
import type { PaperSettings, Pitch } from './paper.js';

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

function asciiBytes(text: string, out: number[]): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out.push(code >= 0x20 && code <= 0x7e ? code : 0x3f);
  }
}

/** 8-dot bands, each a column byte per dot (top dot = bit 7), at ESC * 1 (120 dpi). */
function imageBytes(bitmap: MonoBitmap, offset: number, out: number[]): void {
  out.push(ESC, 0x33, 24); // ESC 3 24: 24/216" = 8 dots per band, so bands touch
  for (let top = 0; top < bitmap.height; top += 8) {
    asciiBytes(' '.repeat(offset), out);
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
  out.push(ESC, 0x32); // back to 1/6"
}

function rowBytes(row: GridRow, out: number[]): void {
  if (row.kind === 'image') {
    imageBytes(row.bitmap, row.offset, out);
    return;
  }
  if (row.bold) out.push(ESC, 0x45); // ESC E
  asciiBytes(row.text, out);
  if (row.bold) out.push(ESC, 0x46); // ESC F
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
  out.push(ESC, 0x32); // ESC 2: 1/6" lines
  out.push(ESC, 0x43, geometry.pageLines); // ESC C n: form length in lines
  out.push(ESC, 0x6c, geometry.leftMargin); // ESC l n: left margin in columns
  for (const page of pages) {
    for (const row of page) rowBytes(row, out);
    out.push(FF);
  }
  out.push(ESC, 0x40);
  return Uint8Array.from(out);
}
