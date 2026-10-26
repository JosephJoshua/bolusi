// A printable document, independent of how it reaches paper. A module builds one from its data with
// every string already in the reader's language; `renderHtml` (plain paper, PDF) and `renderEscp`
// (dot-matrix text mode) lay it out for the paper in use. The renderers own no copy and no business
// rules, so the repair slips now and POS receipts later share one printing layer.
import type { MonoBitmap } from './bitmap.js';

/**
 * An image a document carries: a `data:` URI for HTML, and optionally the same picture as a 1-bit
 * bitmap for a dot-matrix printer. Without `mono`, text mode leaves the image out.
 */
export interface PrintImage {
  readonly dataUri: string;
  readonly mono: MonoBitmap | null;
}

/** The business printed at the top: name, address and phone lines, and an optional logo. */
export interface PrintHeader {
  readonly name: string;
  readonly lines: readonly string[];
  readonly logo: PrintImage | null;
}

export interface PrintField {
  readonly label: string;
  readonly value: string;
}

export interface PrintAmountRow {
  readonly label: string;
  /** Already formatted, e.g. `Rp 250.000`. */
  readonly amount: string;
  readonly strong?: boolean;
}

export interface PrintSignature {
  /** Who signs, e.g. "Pelanggan". */
  readonly role: string;
  /** Printed under the line; null leaves room to write it. */
  readonly name: string | null;
  /** A signature taken on screen, shown above the line on plain paper. Text mode leaves it out. */
  readonly image: PrintImage | null;
}

export type PrintBlock =
  /** A section title. */
  | { readonly kind: 'heading'; readonly text: string }
  /** Label and value pairs, laid out in two columns where the paper is wide enough. */
  | { readonly kind: 'fields'; readonly fields: readonly PrintField[] }
  | { readonly kind: 'paragraph'; readonly text: string; readonly muted?: boolean }
  /** Short items (checks, accessories), packed into columns where they fit. */
  | { readonly kind: 'list'; readonly items: readonly string[] }
  /** Numbered lines of running text, such as terms. */
  | { readonly kind: 'terms'; readonly items: readonly string[] }
  /** Priced lines with right-aligned amounts, then totals. */
  | {
      readonly kind: 'amounts';
      readonly rows: readonly PrintAmountRow[];
      readonly totals: readonly PrintAmountRow[];
    }
  /** Side-by-side signature boxes, kept on one page. */
  | { readonly kind: 'signatures'; readonly slots: readonly PrintSignature[] }
  /** A test pattern that shows the printable width and alignment. */
  | { readonly kind: 'ruler'; readonly caption: string };

export interface PrintDocument {
  /** Names the PDF file and the print job, e.g. `Tanda terima K7Q-0042`. */
  readonly jobName: string;
  readonly header: PrintHeader;
  /** e.g. "TANDA TERIMA SERVISAN". */
  readonly title: string;
  /** The number staff look the paper up by, printed large, e.g. the ticket number. */
  readonly reference: string;
  /** Short lines under the title: dates, "Cetak ulang ke-2". */
  readonly meta: readonly string[];
  readonly blocks: readonly PrintBlock[];
  /**
   * One label per copy, e.g. ["Untuk toko", "Untuk pelanggan"]. On carbonless paper the printer
   * makes every copy in one pass, so `plyNote` is printed instead of separate labelled copies.
   */
  readonly copies: readonly string[];
  /** e.g. "Merah muda untuk toko, kuning untuk pelanggan". */
  readonly plyNote: string | null;
  readonly footer: string | null;
}
