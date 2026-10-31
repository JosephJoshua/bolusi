/**
 * The Bolusi mark's geometry, shared by the phone (`BrandMark`) and the counter PC
 * (`@bolusi/ui-web` `BrandMark`). Drawn from assets/brand, the source SVGs; keep them in step.
 *
 * A lowercase b whose stem curls like a bird of paradise's tail wire, with a gold disc. The three
 * parts are separate so the phone can move each one on its own.
 */
export const brandMark = Object.freeze({
  viewBox: Object.freeze({ x: 92, y: 58, width: 324, height: 400 }),
  strokeWidth: 60,
  /** The bowl of the b. */
  ring: Object.freeze({ cx: 290, cy: 336, r: 86 }),
  /** The stem and its curl. */
  stem: 'M204 336V158C204 106 166 82 128 100',
  /** The gold disc. */
  disc: Object.freeze({ cx: 372, cy: 158, r: 38 }),
} as const);

/** The mark's colours by the background it sits on: `light` surfaces, `dark` bars and the splash. */
export const brandTones = Object.freeze({
  light: Object.freeze({ ink: '#0B4A41', disc: '#E8A21C' }),
  dark: Object.freeze({ ink: '#FFF6E5', disc: '#F5B83D' }),
} as const);

export type BrandTone = keyof typeof brandTones;

/** The splash background (app.config.ts `expo-splash-screen`), which the phone's intro continues. */
export const brandSplash = '#0B4A41';
