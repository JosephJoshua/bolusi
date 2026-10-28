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
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { NATIVE_DRIVER, easeEnter, useReducedMotion } from '../motion.js';
import { color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from '../components/Icon.js';

/** §8.1 states. `pending` carries the count of `local` ops (03-state-machines §3). */
export type SyncChipState = 'synced' | 'pending' | 'syncing' | 'offline' | 'attention';

export interface SyncChipProps {
  readonly state: SyncChipState;
  /** Count of `local` ops — rendered in the `pending` state only (§8.1). */
  readonly pendingCount?: number | undefined;
  /** A new device's first-sync progress, 0–99 — rendered in the `syncing` state only. */
  readonly progressPercent?: number | null | undefined;
  /**
   * Already-localized accessibility label PER state. The chip announces the entry for its own
   * `state`, so a screen-reader user hears what the icon/dot shows — not one state-invariant string
   * (§6.3: colour is never the only signal). A single label cannot do this: `synced` and `attention`
   * look different but sound identical unless the label is chosen by `state` here. `t()` stays out of
   * `@bolusi/ui` (08-stack §3.3) — callers build the map (see `syncChipAccessibilityLabels`).
   */
  readonly accessibilityLabels: Readonly<Record<SyncChipState, string>>;
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

/** One turn of the syncing arrows; slow enough to read as "working", not "stuck". */
const SPIN_MS = 1_200;
const SETTLE_MS = 420;

/**
 * The state's icon, in motion: while syncing the arrows turn, and when everything has just gone
 * through the tick gives a small flutter, like the bird settling. Nothing moves at rest or under
 * reduced motion, so a chip that sits synced all day costs nothing.
 */
function SyncIcon({
  state,
  settled,
  tint,
  testID,
}: {
  readonly state: SyncChipState;
  /** It just went from syncing or pending to synced. Read once: the icon remounts per state. */
  readonly settled: boolean;
  readonly tint: string;
  readonly testID: string;
}): React.JSX.Element {
  const still = useReducedMotion();
  const turn = useRef(new Animated.Value(0)).current;
  const spinning = state === 'syncing' && !still;
  // Kept from mount: a later re-render of the header must not cut the flutter short.
  const [arrived] = useState(settled);
  const fluttering = arrived && !still;

  useEffect(() => {
    if (spinning) {
      const loop = Animated.loop(
        Animated.timing(turn, {
          toValue: 1,
          duration: SPIN_MS,
          easing: Easing.linear,
          useNativeDriver: NATIVE_DRIVER,
        }),
      );
      loop.start();
      return () => loop.stop();
    }
    if (fluttering) {
      const flutter = Animated.timing(turn, {
        toValue: 1,
        duration: SETTLE_MS,
        easing: easeEnter,
        useNativeDriver: NATIVE_DRIVER,
      });
      flutter.start();
      return () => flutter.stop();
    }
    turn.setValue(0);
    return undefined;
  }, [spinning, fluttering, turn]);

  const motionStyle = spinning
    ? {
        transform: [
          { rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
      }
    : fluttering
      ? {
          transform: [
            {
              rotate: turn.interpolate({
                inputRange: [0, 0.25, 0.5, 0.75, 1],
                outputRange: ['0deg', '-14deg', '10deg', '-4deg', '0deg'],
              }),
            },
            {
              scale: turn.interpolate({
                inputRange: [0, 0.3, 1],
                outputRange: [0.8, 1.15, 1],
              }),
            },
          ],
        }
      : null;

  return (
    <Animated.View style={motionStyle}>
      <Icon testID={testID} name={STATE_ICON[state]} size={size.iconInline} color={tint} />
    </Animated.View>
  );
}

export function SyncChip({
  state,
  pendingCount,
  progressPercent,
  accessibilityLabels,
  onPress,
  testID = 'ui.syncChip',
}: SyncChipProps): React.JSX.Element {
  const tint = STATE_COLOR[state];
  // Where the chip was a render ago, so "just synced" can be told from "synced since boot".
  const previous = useRef(state);
  const settled =
    state === 'synced' && (previous.current === 'syncing' || previous.current === 'pending');
  useEffect(() => {
    previous.current = state;
  }, [state]);

  return (
    <Pressable
      testID={testID}
      // The state is in the testID so a screen test can assert WHICH state is showing without
      // reading copy (testing-guide T-4).
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabels[state]}
      onPress={onPress}
      style={styles.base}
    >
      <SyncIcon
        // A new state is a new icon: its motion starts from rest.
        key={state}
        state={state}
        settled={settled}
        tint={tint}
        testID={`${testID}.icon.${state}`}
      />

      {state === 'pending' && pendingCount !== undefined ? (
        <Text testID={`${testID}.count`} style={[styles.count, { color: tint }]}>
          {pendingCount}
        </Text>
      ) : null}

      {state === 'syncing' && progressPercent !== undefined && progressPercent !== null ? (
        <Text testID={`${testID}.progress`} style={[styles.count, { color: tint }]}>
          {`${progressPercent}%`}
        </Text>
      ) : null}

      {/* §8.1: `attention` is a danger DOT alongside the icon — colour is never the only signal (§6.3). */}
      {state === 'attention' ? <View testID={`${testID}.dot`} style={styles.dot} /> : null}
    </Pressable>
  );
}
