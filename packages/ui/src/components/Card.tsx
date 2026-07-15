/**
 * Card (design-system §3.4) — dashboard/detail grouping.
 *
 * No shadow, ever (§1.3): depth is `border.hairline` + `surfaceAlt`, because shadows cost GPU
 * overdraw on the low-end GPUs in §0.
 *
 * §3.4: cards are static OR fully tappable — never a patchwork of tap zones. `onPress` makes the
 * WHOLE card the target, which is why there is no per-region handler here.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { border, color, radius, space } from '../tokens.js';

export interface CardProps {
  readonly children: ReactNode;
  /** Present ⇒ the entire card is one button. */
  readonly onPress?: (() => void) | undefined;
  /** Already-localized; required when the card is tappable so the target announces itself (§6.4). */
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderWidth: border.hairline,
    borderColor: color.border,
    padding: space.lg,
  },
});

export function Card({
  children,
  onPress,
  accessibilityLabel,
  testID = 'ui.card',
}: CardProps): React.JSX.Element {
  if (onPress === undefined) {
    return (
      <View testID={testID} style={[styles.base, { backgroundColor: color.surface }]}>
        {children}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: pressed ? color.surfaceAlt : color.surface },
      ]}
    >
      {children}
    </Pressable>
  );
}
