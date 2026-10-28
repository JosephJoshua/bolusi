// The Bolusi logo: a lowercase b whose top curls like a bird of paradise's tail wire, with a
// gold disc. Drawn from assets/brand (the source SVGs); keep the two in step.

const TONES = {
  light: { ink: '#0B4A41', disc: '#E8A21C' },
  dark: { ink: '#FFF6E5', disc: '#F5B83D' },
} as const;

/** "olusi" in Plus Jakarta Sans ExtraBold, outlined, set after the mark. */
const WORD = [
  'M97.9 1.2Q89.8 1.2 83.2 -2.5Q76.5 -6.2 72.6 -12.7Q68.6 -19.1 68.6 -27.3',
  'Q68.6 -35.6 72.6 -42Q76.5 -48.4 83.2 -52.1Q89.8 -55.8 97.9 -55.8Q106 -55.8 112.6 -52.1',
  'Q119.2 -48.4 123.2 -42Q127.1 -35.6 127.1 -27.3Q127.1 -19.1 123.2 -12.7',
  'Q119.2 -6.2 112.6 -2.5Q106 1.2 97.9 1.2ZM97.9 -12.3Q102 -12.3 105.1 -14.2',
  'Q108.1 -16.1 109.9 -19.5Q111.6 -22.9 111.6 -27.3Q111.6 -31.7 109.9 -35.1',
  'Q108.1 -38.4 105.1 -40.4Q102 -42.3 97.9 -42.3Q93.8 -42.3 90.7 -40.4',
  'Q87.6 -38.4 85.9 -35.1Q84.1 -31.7 84.1 -27.3Q84.1 -22.9 85.9 -19.5Q87.6 -16.1 90.7 -14.2',
  'Q93.8 -12.3 97.9 -12.3ZM134.7 0V-75.7H149.7V0ZM179.1 1.2Q172.5 1.2 167.9 -1.6',
  'Q163.2 -4.5 160.8 -9.6Q158.4 -14.7 158.4 -21.5V-54.6H173.4V-22.7Q173.4 -19.6 174.7 -17.2',
  'Q175.9 -14.9 178.2 -13.6Q180.5 -12.3 183.4 -12.3Q186.4 -12.3 188.7 -13.6',
  'Q190.9 -14.9 192.2 -17.2Q193.4 -19.6 193.4 -22.7V-54.6H208.4V0H194.4V-10.8L195.2 -8.4',
  'Q193.3 -3.5 189.1 -1.1Q184.8 1.2 179.1 1.2ZM239.6 1.2Q230.6 1.2 224 -3.1',
  'Q217.3 -7.3 214.9 -14.5L225.9 -19.7Q228 -15.3 231.6 -12.8Q235.2 -10.3 239.6 -10.3',
  'Q242.8 -10.3 244.5 -11.6Q246.2 -12.9 246.2 -15.2Q246.2 -16.4 245.6 -17.2',
  'Q245 -18.1 243.8 -18.8Q242.6 -19.5 240.8 -20L231.5 -22.6Q224.8 -24.5 221.2 -28.8',
  'Q217.6 -33 217.6 -38.8Q217.6 -43.9 220.2 -47.7Q222.8 -51.5 227.5 -53.7',
  'Q232.2 -55.8 238.3 -55.8Q246.3 -55.8 252.4 -52.1Q258.4 -48.3 260.9 -41.5L249.8 -36.3',
  'Q248.6 -39.7 245.5 -41.8Q242.3 -43.8 238.3 -43.8Q235.4 -43.8 233.8 -42.6',
  'Q232.1 -41.4 232.1 -39.3Q232.1 -38.2 232.7 -37.3Q233.3 -36.4 234.7 -35.7',
  'Q236 -35 238 -34.4L246.7 -31.8Q253.5 -29.8 257.1 -25.8Q260.7 -21.7 260.7 -15.8',
  'Q260.7 -10.7 258.1 -6.9Q255.4 -3.1 250.7 -0.9Q246 1.2 239.6 1.2ZM268.5 0V-54.6H283.5V0Z',
  'M268.5 -59.5V-74.5H283.5V-59.5Z',
].join('');

function Mark({ ink, disc }: { readonly ink: string; readonly disc: string }): React.JSX.Element {
  return (
    <>
      <g fill="none" stroke={ink} strokeWidth={60} strokeLinecap="round">
        <circle cx={290} cy={336} r={86} />
        <path d="M204 336V158C204 106 166 82 128 100" />
      </g>
      <circle cx={372} cy={158} r={38} fill={disc} />
    </>
  );
}

/**
 * The logo at `size` px tall. `tone` is the background it sits on: `light` for white and pale
 * surfaces, `dark` for dark bars. The wordmark spells "bolusi" with the mark as its b.
 */
export function BrandMark({
  size = 24,
  tone = 'light',
  variant = 'mark',
  label = 'Bolusi',
}: {
  readonly size?: number;
  readonly tone?: keyof typeof TONES;
  readonly variant?: 'mark' | 'wordmark';
  /** The accessible name; pass null when a visible "Bolusi" already sits beside it. */
  readonly label?: string | null;
}): React.JSX.Element {
  const colors = TONES[tone];
  const a11y = label === null ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  if (variant === 'mark') {
    return (
      <svg viewBox="92 58 324 400" height={size} width={(size * 324) / 400} {...a11y}>
        <Mark {...colors} />
      </svg>
    );
  }
  return (
    <svg viewBox="-2 -79.5 293 83.5" height={size} width={(size * 293) / 83.5} {...a11y}>
      <g transform="translate(-19.57 -89.08) scale(0.19974)">
        <Mark {...colors} />
      </g>
      <path fill={colors.ink} d={WORD} />
    </svg>
  );
}
