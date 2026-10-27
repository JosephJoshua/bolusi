// Paper sizes and the text geometry a dot-matrix printer gets from them.
//
// The printer model is unknown and Windows printing cannot report the paper in it, so the store picks
// a preset or types the size, and checks it with a test page. Continuous (tractor-feed) paper loses
// its punched strips at both sides, which is why it gets wider side margins than cut sheets.
import { z } from 'zod';

export const PAPER_PRESET_IDS = [
  'continuous_full',
  'continuous_half',
  'a4',
  'a4_landscape',
  'a5',
  'a5_landscape',
  'custom',
] as const;
export type PaperPresetId = (typeof PAPER_PRESET_IDS)[number];

export interface PaperSettings {
  readonly preset: PaperPresetId;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Tractor-feed paper with punched strips at both sides. */
  readonly continuous: boolean;
  /** Multi-part carbonless paper: one print makes every copy. */
  readonly carbonless: boolean;
}

export const MIN_PAPER_MM = 50;
export const MAX_PAPER_WIDTH_MM = 420;
export const MAX_PAPER_HEIGHT_MM = 600;

export const zPaperSettings = z
  .object({
    preset: z.enum(PAPER_PRESET_IDS),
    widthMm: z.number().int().min(MIN_PAPER_MM).max(MAX_PAPER_WIDTH_MM),
    heightMm: z.number().int().min(MIN_PAPER_MM).max(MAX_PAPER_HEIGHT_MM),
    continuous: z.boolean(),
    carbonless: z.boolean(),
  })
  .strict();

/**
 * 9.5 inch continuous paper, 11 inches (full, portrait) or 5.5 inches (half, landscape) between
 * perforations, and A4 and A5 cut sheets either way round.
 */
export const PAPER_PRESETS: Readonly<Record<Exclude<PaperPresetId, 'custom'>, PaperSettings>> = {
  continuous_full: {
    preset: 'continuous_full',
    widthMm: 241,
    heightMm: 279,
    continuous: true,
    carbonless: true,
  },
  continuous_half: {
    preset: 'continuous_half',
    widthMm: 241,
    heightMm: 140,
    continuous: true,
    carbonless: true,
  },
  a4: { preset: 'a4', widthMm: 210, heightMm: 297, continuous: false, carbonless: false },
  a4_landscape: {
    preset: 'a4_landscape',
    widthMm: 297,
    heightMm: 210,
    continuous: false,
    carbonless: false,
  },
  a5: { preset: 'a5', widthMm: 148, heightMm: 210, continuous: false, carbonless: false },
  a5_landscape: {
    preset: 'a5_landscape',
    widthMm: 210,
    heightMm: 148,
    continuous: false,
    carbonless: false,
  },
};

/**
 * What a store prints on until it picks something else: the pilot's carbonless dot-matrix forms,
 * the short landscape kind, where a slip fits one form.
 */
export const DEFAULT_PAPER: PaperSettings = PAPER_PRESETS.continuous_half;

/** Wider than tall: the layout puts secondary sections in a column beside the body. */
export function isLandscape(paper: PaperSettings): boolean {
  return paper.widthMm > paper.heightMm;
}

const MM_PER_INCH = 25.4;

/** Characters per inch the renderer can pick: pica, elite, condensed (`SI` on pica). */
export type Pitch = 10 | 12 | 17;

/**
 * Line spacing: 1/6" is the printer's default and easiest to read; 1/8" still clears a draft
 * character's descenders and fits a third more on a form, for a slip that would otherwise spill.
 */
export type LinesPerInch = 6 | 8;

/** Narrower than this and labels and amounts stop fitting side by side, so a smaller pitch is used. */
const MIN_COLUMNS = 60;

export interface TextGeometry {
  readonly pitch: Pitch;
  /** Characters per line. */
  readonly columns: number;
  /** Characters skipped from the print head's leftmost position. */
  readonly leftMargin: number;
  readonly linesPerInch: LinesPerInch;
  /** Lines between perforations. */
  readonly pageLines: number;
}

/** Inches lost at each side: the punched strip and a little room on continuous paper. */
function sideMarginInches(paper: PaperSettings): number {
  return paper.continuous ? 0.75 : 0.25;
}

/**
 * The text grid for a paper: the widest pitch that still gives `MIN_COLUMNS` (10 cpi on 9.5"
 * continuous gives 80 columns), else condensed. ESC/P sets form length in lines up to 127.
 */
export function textGeometry(paper: PaperSettings, linesPerInch: LinesPerInch = 6): TextGeometry {
  const widthIn = paper.widthMm / MM_PER_INCH;
  const margin = sideMarginInches(paper);
  // A hair of slack so 241 mm (9.49") still counts as the 9.5" paper it is.
  const printable = Math.max(1, widthIn - 2 * margin + 0.02);
  const pitch: Pitch =
    Math.floor(printable * 10) >= MIN_COLUMNS
      ? 10
      : Math.floor(printable * 12) >= MIN_COLUMNS
        ? 12
        : 17;
  // Condensed pica is 17.14 cpi; round down so the last column never wraps.
  const cpi = pitch === 17 ? 17.14 : pitch;
  return {
    pitch,
    columns: Math.floor(printable * cpi),
    leftMargin: Math.round(margin * cpi),
    linesPerInch,
    pageLines: Math.min(
      127,
      Math.max(12, Math.round((paper.heightMm / MM_PER_INCH) * linesPerInch)),
    ),
  };
}
