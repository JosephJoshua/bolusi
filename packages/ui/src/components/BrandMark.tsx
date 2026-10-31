/**
 * BrandMark — the Bolusi logo on the phone, from the shared geometry in `brand.ts`.
 *
 * `parts` draws only some pieces of the mark on the full canvas, so pieces stacked on each other
 * line up exactly and each can be moved on its own (the opening intro). By default, the whole mark.
 */
import { Circle, Path, Svg } from 'react-native-svg';

import { brandMark, brandTones, type BrandTone } from '../brand.js';

export type BrandMarkPart = 'ring' | 'stem' | 'disc';

export interface BrandMarkProps {
  /** Height in dp; the width follows the mark's proportions. */
  readonly size: number;
  /** The background it sits on: `light` surfaces, `dark` bars and the splash. */
  readonly tone?: BrandTone | undefined;
  readonly parts?: readonly BrandMarkPart[] | undefined;
  /** Already-localized accessible name; `null` when it is decoration beside a visible name. */
  readonly label?: string | null | undefined;
  readonly testID?: string | undefined;
}

const { viewBox: box, ring, disc } = brandMark;
const WHOLE: readonly BrandMarkPart[] = ['ring', 'stem', 'disc'];
const VIEW_BOX = `${String(box.x)} ${String(box.y)} ${String(box.width)} ${String(box.height)}`;

/** The mark's width for a given height. */
export function brandMarkWidth(height: number): number {
  return (height * box.width) / box.height;
}

export function BrandMark({
  size,
  tone = 'light',
  parts = WHOLE,
  label = null,
  testID,
}: BrandMarkProps): React.JSX.Element {
  const colors = brandTones[tone];
  const stroke = {
    fill: 'none',
    stroke: colors.ink,
    strokeWidth: brandMark.strokeWidth,
    strokeLinecap: 'round',
  } as const;
  return (
    <Svg
      viewBox={VIEW_BOX}
      width={brandMarkWidth(size)}
      height={size}
      {...(testID === undefined ? {} : { testID })}
      {...(label === null
        ? { accessible: false }
        : { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label })}
    >
      {parts.includes('ring') ? <Circle cx={ring.cx} cy={ring.cy} r={ring.r} {...stroke} /> : null}
      {parts.includes('stem') ? <Path d={brandMark.stem} {...stroke} /> : null}
      {parts.includes('disc') ? (
        <Circle cx={disc.cx} cy={disc.cy} r={disc.r} fill={colors.disc} />
      ) : null}
    </Svg>
  );
}
