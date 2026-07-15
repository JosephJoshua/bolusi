/**
 * LoadingState (design-system §3.9).
 *
 * Three rules from §3.9/§4, all load-bearing:
 *
 * 1. NOTHING for the first 300 ms. Local projection queries resolve in milliseconds; showing a
 *    skeleton for 40 ms is a flash of noise, not feedback. (A local query still loading at 1 s is a
 *    DEFECT to file — not a UX case to design for.)
 * 2. NO SHIMMER. Static `surfaceAlt` blocks. An animation loop costs GPU on the §0 low-end target
 *    and buys nothing; there is no animation library in v0 (§7).
 * 3. NEVER for a local action's network round-trip (§4.2). If you are rendering this while waiting
 *    on the server, the design is wrong — network progress belongs to the sync chip alone (§4.6).
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { color, radius, space, touch } from '../tokens.js';

/** §3.9: render nothing before this, to avoid a flash on queries that resolve in ms. */
export const LOADING_DELAY_MS = 300;

/** §3.9: lists get exactly 6 ghost rows matching ListRow geometry. */
export const SKELETON_ROW_COUNT = 6;

export interface LoadingStateProps {
  /**
   * §3.9: `skeleton` for lists (geometry-stable, no layout jump on resolve); `spinner` for
   * non-list content expected under 1 s.
   */
  readonly variant?: 'skeleton' | 'spinner' | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  spinnerRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  // Ghost rows match ListRow geometry exactly (§3.9 layout stability): same height, same padding,
  // so the real rows land where the ghosts were with no jump.
  ghostRow: {
    height: touch.row,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  ghostBlock: {
    height: space.lg,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
  },
});

export function LoadingState({
  variant = 'skeleton',
  testID = 'ui.loadingState',
}: LoadingStateProps): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  if (variant === 'spinner') {
    return (
      <View testID={testID} style={styles.spinnerRoot}>
        <ActivityIndicator testID={`${testID}.spinner`} color={color.primary} />
      </View>
    );
  }

  return (
    <View testID={testID}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <View key={index} testID={`${testID}.row.${index}`} style={styles.ghostRow}>
          <View style={styles.ghostBlock} />
        </View>
      ))}
    </View>
  );
}
