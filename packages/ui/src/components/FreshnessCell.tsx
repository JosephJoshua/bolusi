/**
 * FreshnessCell — the staleness-tier indicator (design-system §3.11, §8.4).
 *
 * THE SIGNATURE ELEMENT OF THIS DESIGN SYSTEM. The reasoning, because it is not decoration:
 *
 * This product's core promise is that it never lies about how old its data is — in a place where
 * the power dies for two days. So freshness is the most characteristic thing in its world, and it
 * deserves a real instrument rather than a grey timestamp chip.
 *
 * The instrument is a BATTERY CELL, drawn in the shop's own vernacular: this is a phone-repair
 * counter, where a charge level is the single most-read glyph in the building. A technician reads a
 * cell's fill faster than any word, in any language, at any literacy level. The metaphor is also
 * literally true of the system: local data holds a charge that drains while you are offline, and
 * syncing recharges it.
 *
 * Why it survives this environment specifically (§0):
 *   - FILL, not hue, is the primary signal. On a dimmed cheap LCD in equatorial sun, hue washes out
 *     and mid-greys crush — a fill fraction is a shape, and shape survives. Colour only reinforces.
 *   - It is therefore colourblind-safe and readable at a glance without reading (§6.3).
 *   - It never animates: no shimmer, no drain animation. Static costs no GPU on the 2 GB target
 *     (§7), and it means `prefers-reduced-motion` has nothing to honour here by construction.
 *
 * THREE DISCRETE STATES, NEVER A PERCENTAGE. The input is the LEVEL NAME from 03-state-machines §8
 * (`fresh|warning|stale`). A continuous fill would require the age and therefore the thresholds,
 * and §8 is the sole numeric source for those. Discrete keeps this component honest AND keeps the
 * numbers where they belong.
 *
 * Built from Views, not SVG: no new dependency (§0, §7).
 */
import { StyleSheet, View } from 'react-native';

import { border, color, radius, size } from '../tokens.js';
import type { StalenessLevel } from './Banner.js';

export interface FreshnessCellProps {
  /** Derived level from 03-state-machines §8. Thresholds live ONLY there. */
  readonly level: StalenessLevel;
  /**
   * Already-localized. Supply when the cell stands alone (e.g. §8.4 status header) so it announces
   * itself; omit inside a Banner, whose message already says it — double-announcing is noise.
   */
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}

/**
 * Fill fraction per level. `stale` is EMPTY, not "red" — a technician who cannot distinguish the
 * colours still sees an empty cell and knows the data is flat.
 */
const LEVEL = {
  fresh: { fill: 1, tint: color.textMuted },
  warning: { fill: 0.5, tint: color.warning },
  stale: { fill: 0, tint: color.danger },
} as const satisfies Record<StalenessLevel, { fill: number; tint: string }>;

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center' },
  body: {
    width: size.cellWidth,
    height: size.cellHeight,
    borderWidth: border.focus,
    borderRadius: radius.xs,
    padding: size.cellGap,
    justifyContent: 'center',
  },
  fill: { height: '100%', borderRadius: radius.xs },
  // The terminal nub is what makes the glyph read as a CELL rather than a progress bar at 14 dp.
  nub: {
    width: size.cellNub,
    height: size.cellNubHeight,
    borderTopRightRadius: radius.xs,
    borderBottomRightRadius: radius.xs,
  },
});

export function FreshnessCell({
  level,
  accessibilityLabel,
  testID = 'ui.freshnessCell',
}: FreshnessCellProps): React.JSX.Element {
  const { fill, tint } = LEVEL[level];

  return (
    <View
      // The level is in the testID so a screen test asserts WHICH tier is showing without reading
      // copy (testing-guide T-4).
      testID={`${testID}.${level}`}
      {...(accessibilityLabel === undefined
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no' as const }
        : { accessibilityRole: 'image' as const, accessibilityLabel })}
      style={styles.root}
    >
      <View style={[styles.body, { borderColor: tint }]}>
        {fill > 0 ? (
          <View
            testID={`${testID}.fill`}
            style={[styles.fill, { backgroundColor: tint, width: `${fill * 100}%` }]}
          />
        ) : null}
      </View>
      <View style={[styles.nub, { backgroundColor: tint }]} />
    </View>
  );
}
