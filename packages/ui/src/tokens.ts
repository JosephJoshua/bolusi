/**
 * Design tokens — the ONLY styling vocabulary in the app (design-system §1).
 *
 * This is the sole file in the repo allowed to contain colour/size literals; everywhere else the
 * `bolusi/no-token-literals` lint rule (08-stack §5.2) makes a raw hex or a raw dp value an error.
 * Every value below is transcribed from design-system §1 — that doc is the source of truth and
 * changes there land here, never the reverse.
 *
 * The palette and the spacing scale are CLOSED: adding a colour or an in-between spacing step
 * requires a design-system change first (§1.1, §1.3). Objects are frozen so a screen cannot
 * mutate the vocabulary at runtime.
 *
 * Dark mode is deferred (§1.1). These semantic names ARE the dark-mode enabler: a future dark
 * theme is a second map behind the same names, with zero component changes. Never bypass the
 * indirection by reaching for a raw value.
 */

/** Semantic colour tokens, light theme (design-system §1.1). */
export const color = Object.freeze({
  primary: '#1D4ED8',
  primaryPressed: '#1E40AF',
  onPrimary: '#FFFFFF',
  success: '#15803D',
  successBg: '#DCFCE7',
  /** Paired text on `successBg` — §1.1 "Pair text #166534". */
  onSuccessBg: '#166534',
  /** Warning is TEXT/icon only — never a filled-button colour (white-on-amber fails 4.5:1, §1.1). */
  warning: '#92400E',
  warningBg: '#FEF3C7',
  danger: '#B91C1C',
  dangerPressed: '#991B1B',
  dangerBg: '#FEE2E2',
  /** Paired text on `dangerBg` — §1.1 "Pair text #991B1B" (same value as `dangerPressed`). */
  onDangerBg: '#991B1B',
  onDanger: '#FFFFFF',
  info: '#1E40AF',
  infoBg: '#DBEAFE',
  surface: '#FFFFFF',
  surfaceAlt: '#F4F4F5',
  border: '#D4D4D8',
  text: '#18181B',
  textMuted: '#52525B',
  /** Disabled labels ONLY — the sole exemption from the §6.1 contrast floor. */
  textDisabled: '#A1A1AA',
  /** Scrim behind ConfirmSheet only (§1.3); `#18181B` @ 40% per §1.1. */
  overlay: '#18181B',
  /** Text/initials on any `identityPalette` hue (§1.5). */
  onIdentity: '#FFFFFF',
} as const);

/**
 * Identity hues (design-system §1.5) — the per-user Avatar palette.
 *
 * This is an IDENTITY ramp, not a semantic one, and the distinction is load-bearing: these colours
 * carry no status meaning and are never used to signal state, so §6.3's "no colour-only signalling"
 * is untouched (initials are text; the hue is an accelerator for recognition, not the information).
 *
 * Why it exists: PRD-011 §6.1 says these users find themselves by face, not by reading a name, and
 * v0 has no photo-upload UI. A stable hue per person is what makes an initials disc recognisable in
 * peripheral vision instead of something you must stop and read (§3.12).
 *
 * Constraints on membership, all deliberate:
 *   - Every hue clears 4.5:1 against `onIdentity` — asserted by `tokens.test.ts`, so no user can be
 *     dealt an unreadable disc.
 *   - All are DARK and saturated: on a dimmed cheap LCD in equatorial sun (§0), light tints wash
 *     out to the same pale smudge and stop being distinguishable from each other.
 *   - None is red or `color.primary`: red is `danger` and blue is "act" (§1.1 "never repurpose") —
 *     a person must not read as an error or a button.
 */
export const identityPalette = Object.freeze([
  '#0C4A6E',
  '#14532D',
  '#581C87',
  '#7C2D12',
  '#831843',
  '#115E59',
  '#713F12',
  '#3F3F46',
] as const);

/** Opacity of the ConfirmSheet scrim (design-system §1.1 `color.overlay` = `#18181B` @ 40%). */
export const overlayOpacity = 0.4;

/**
 * Type scale (design-system §1.2). Base is deliberately large (body 18) for small, low-brightness
 * screens. Nothing below 14 ships — `caption` is the floor.
 *
 * `fontFamily` is never set: v0 ships no custom font (§2), so Android renders Roboto and iOS SF.
 * `allowFontScaling` stays default-on so OS font scaling is respected (§6.5).
 */
export const type = Object.freeze({
  display: Object.freeze({ fontSize: 32, lineHeight: 40, fontWeight: '700' }),
  title: Object.freeze({ fontSize: 24, lineHeight: 32, fontWeight: '700' }),
  heading: Object.freeze({ fontSize: 20, lineHeight: 28, fontWeight: '600' }),
  body: Object.freeze({ fontSize: 18, lineHeight: 26, fontWeight: '400' }),
  bodyBold: Object.freeze({ fontSize: 18, lineHeight: 26, fontWeight: '600' }),
  bodySm: Object.freeze({ fontSize: 16, lineHeight: 24, fontWeight: '400' }),
  caption: Object.freeze({ fontSize: 14, lineHeight: 20, fontWeight: '400' }),
} as const);

/** Tabular numerals for money/counts (design-system §2). Applied alongside a `type` entry. */
export const numeric = Object.freeze({ fontVariant: Object.freeze(['tabular-nums']) } as const);

/** 4-dp base grid; the scale is CLOSED — no in-between values (design-system §1.3). */
export const space = Object.freeze({
  xs: 4,
  sm: 8,
  md: 12,
  /** Default screen padding. */
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const);

/** Corner radii (design-system §1.3). */
export const radius = Object.freeze({
  /** §3.11 FreshnessCell only — at 14 dp tall, `sm` would round the cell into a lozenge. */
  xs: 4,
  sm: 8,
  md: 12,
  full: 999,
} as const);

/**
 * Border widths (design-system §1.3). There are deliberately no elevation/shadow tokens in v0 —
 * depth is `border.hairline` + `surfaceAlt`, because shadows cost GPU overdraw on the 2 GB target.
 */
export const border = Object.freeze({
  hairline: 1,
  focus: 2,
} as const);

/** Touch-target floors (design-system §1.4). `min` is a hard floor with no exceptions. */
export const touch = Object.freeze({
  /** EVERY interactive element, via size or `hitSlop`. */
  min: 48,
  /** Primary/destructive button height; bottom action bar. */
  primary: 56,
  /** PIN pad / numeric keypad keys. */
  key: 64,
  /** List rows: 56 minimum, 64 default. */
  rowMin: 56,
  row: 64,
  /** Minimum spacing between adjacent targets. */
  gap: 8,
} as const);

/**
 * Component geometry fixed by design-system §3/§8 (chip height 28, ListRow leading slot 40,
 * EmptyState glyph 48, header 56, …).
 *
 * DEVIATION, declared for review: §1 names four token groups (colour, type, spacing, touch) and
 * does not define a `size` group — but §3/§8 DO fix these dimensions, and §7's lint rule makes
 * `tokens.ts` the only legal home for a size literal. Rather than sprinkle `// eslint-disable`
 * across the components or invent values at each call site, the §3/§8 numbers are collected here
 * with the subsection that owns each one. No value is invented: every entry cites its source.
 */
export const size = Object.freeze({
  /** §3.5 Chip height (hit area padded to `touch.min` when tappable). */
  chip: 28,
  /** §3.5 Chip icon — mandatory, no color-only signalling. */
  iconChip: 16,
  /** §3.6 Banner / inline icon. */
  iconInline: 20,
  /** §3.8 EmptyState / ErrorState / UnauthorizedState centred glyph. */
  iconState: 48,
  /** §3.4 ListRow leading slot (icon/avatar). */
  avatarRow: 40,
  /** §8.1 header avatar button. */
  avatar: 48,
  /**
   * §8.2 User Switcher grid. Big enough to be a FACE rather than a bullet point — PRD-011 §6.1
   * makes recognition the whole job of that screen, and a 48 dp disc in a 2-column grid wastes the
   * one screen where identity IS the content.
   */
  avatarSwitcher: 96,
  /** §3.11 FreshnessCell geometry — the battery-cell signature. */
  cellWidth: 26,
  cellHeight: 14,
  cellGap: 2,
  cellNub: 3,
  cellNubHeight: 6,
  /** §8.1 header height. */
  header: 56,
  /** §3.6 collapsed-warning header dot. */
  bannerDot: 12,
  /** §3.3 PIN entry dot. */
  pinDot: 16,
} as const);

/**
 * Foreground/background pairs from design-system §1.1 "Usage", declared so the contrast test can
 * mechanically prove every one clears the §6.1 floor of 4.5:1.
 *
 * This list is the gate: adding a pair without passing contrast fails `tokens.test.ts`. It is the
 * reason a reviewer never has to eyeball a hex value.
 *
 * `textDisabled` appears nowhere here — it is the single WCAG-sanctioned exemption (§6.1), and
 * `tokens.test.ts` asserts that exemption is exercised rather than silently forgotten.
 */
export const contrastPairs = Object.freeze([
  Object.freeze({ name: 'text on surface', fg: color.text, bg: color.surface }),
  Object.freeze({ name: 'text on surfaceAlt', fg: color.text, bg: color.surfaceAlt }),
  Object.freeze({ name: 'textMuted on surface', fg: color.textMuted, bg: color.surface }),
  Object.freeze({ name: 'textMuted on surfaceAlt', fg: color.textMuted, bg: color.surfaceAlt }),
  Object.freeze({ name: 'onPrimary on primary', fg: color.onPrimary, bg: color.primary }),
  Object.freeze({
    name: 'onPrimary on primaryPressed',
    fg: color.onPrimary,
    bg: color.primaryPressed,
  }),
  Object.freeze({ name: 'primary on surface', fg: color.primary, bg: color.surface }),
  Object.freeze({ name: 'warning on warningBg', fg: color.warning, bg: color.warningBg }),
  Object.freeze({ name: 'onDangerBg on dangerBg', fg: color.onDangerBg, bg: color.dangerBg }),
  Object.freeze({ name: 'info on infoBg', fg: color.info, bg: color.infoBg }),
  Object.freeze({ name: 'success on surface', fg: color.success, bg: color.surface }),
  Object.freeze({ name: 'onSuccessBg on successBg', fg: color.onSuccessBg, bg: color.successBg }),
  Object.freeze({ name: 'onDanger on danger', fg: color.onDanger, bg: color.danger }),
  Object.freeze({ name: 'onDanger on dangerPressed', fg: color.onDanger, bg: color.dangerPressed }),
  Object.freeze({ name: 'danger on surface', fg: color.danger, bg: color.surface }),
  // §1.5: every identity hue must carry white initials. Generated, not hand-listed, so adding a
  // hue to `identityPalette` automatically puts it under the contrast gate.
  ...identityPalette.map((hue) =>
    Object.freeze({ name: `onIdentity on ${hue}`, fg: color.onIdentity, bg: hue }),
  ),
]);

export type ContrastPair = (typeof contrastPairs)[number];
