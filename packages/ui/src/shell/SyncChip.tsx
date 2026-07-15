/**
 * SyncChip (design-system §8.1) — the header's ambient network affordance.
 *
 * This is THE ONLY permanent network affordance in the app (§4.6). That is the whole point: network
 * state is ambient, never blocking, and it lives here so that no button, screen, or flow ever has
 * to mention it.
 *
 * `offline` is NEUTRAL, never red (§4.6): offline is a normal operating mode for this product, not
 * an error. Only `attention` — a rejected op or a revocation — earns the danger token.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from '../components/Icon.js';

/** §8.1 states. `pending` carries the count of `local` ops (03-state-machines §3). */
export type SyncChipState = 'synced' | 'pending' | 'syncing' | 'offline' | 'attention';

export interface SyncChipProps {
  readonly state: SyncChipState;
  /** Count of `local` ops — rendered in the `pending` state only (§8.1). */
  readonly pendingCount?: number | undefined;
  /** Already-localized accessibility label describing the current state. */
  readonly accessibilityLabel: string;
  /** §8.1: tap → Sync Status screen. */
  readonly onPress: () => void;
  readonly testID?: string | undefined;
}

const STATE_ICON: Record<SyncChipState, IconName> = {
  synced: 'syncSynced',
  pending: 'pending',
  syncing: 'syncSyncing',
  offline: 'syncOffline',
  attention: 'rejected',
};

const STATE_COLOR: Record<SyncChipState, string> = {
  synced: color.textMuted,
  pending: color.textMuted,
  syncing: color.textMuted,
  // Neutral, NOT red — offline is normal (§4.6).
  offline: color.textMuted,
  attention: color.danger,
};

const styles = StyleSheet.create({
  base: {
    minWidth: touch.min,
    height: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
  },
  count: { ...type.caption, marginLeft: space.xs },
  dot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.full,
    backgroundColor: color.danger,
    marginLeft: space.xs,
  },
});

export function SyncChip({
  state,
  pendingCount,
  accessibilityLabel,
  onPress,
  testID = 'ui.syncChip',
}: SyncChipProps): React.JSX.Element {
  const tint = STATE_COLOR[state];

  return (
    <Pressable
      testID={testID}
      // The state is in the testID so a screen test can assert WHICH state is showing without
      // reading copy (testing-guide T-4).
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.base}
    >
      <Icon
        testID={`${testID}.icon.${state}`}
        name={STATE_ICON[state]}
        size={size.iconInline}
        color={tint}
      />

      {state === 'pending' && pendingCount !== undefined ? (
        <Text testID={`${testID}.count`} style={[styles.count, { color: tint }]}>
          {pendingCount}
        </Text>
      ) : null}

      {/* §8.1: `attention` is a danger DOT alongside the icon — colour is never the only signal (§6.3). */}
      {state === 'attention' ? <View testID={`${testID}.dot`} style={styles.dot} /> : null}
    </Pressable>
  );
}
