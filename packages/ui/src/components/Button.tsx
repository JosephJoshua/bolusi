/**
 * Button (design-system §3.1). Three variants × four mandatory states.
 *
 * There is deliberately NO `style` / `color` override prop. §1.1 fixes semantic meaning ("never
 * repurpose"), and an escape hatch is how a palette-closed system stops being closed: one screen
 * passes `color.danger` for emphasis and the meaning of red is gone app-wide. A new look = a new
 * variant = a design-system change first.
 */
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from 'react-native';

import { usePressScale } from '../motion.js';
import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

export interface ButtonProps {
  /** Already-localized (§3 preamble: components never resolve labels). */
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * LOCAL work only. §4.2 is absolute: a button must never spin waiting for the network. If you
   * are reaching for `busy` because a request is in flight, the design is wrong — commands append
   * locally and return instantly (§4.1).
   */
  readonly busy?: boolean | undefined;
  /**
   * `compact` is for a secondary action among content (a row of status actions on a detail screen):
   * drawn 36 dp tall with its hit area padded to the 48 dp floor. The bottom action stays `regular`.
   */
  readonly size?: 'regular' | 'compact' | undefined;
  readonly testID?: string | undefined;
}

const FILL = {
  primary: { default: color.primary, pressed: color.primaryPressed },
  secondary: { default: color.surface, pressed: color.surfaceAlt },
  destructive: { default: color.danger, pressed: color.dangerPressed },
} as const;

const LABEL_COLOR = {
  primary: color.onPrimary,
  secondary: color.primary,
  destructive: color.onDanger,
} as const;

const styles = StyleSheet.create({
  base: {
    // minHeight, not height: a label that wraps to its second line grows the button instead of
    // touching its edges (a long store name at 1.3x font).
    minHeight: touch.primary,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  secondaryOutline: {
    borderWidth: border.hairline,
    borderColor: color.border,
  },
  compact: {
    minHeight: sizes.control,
    paddingVertical: 0,
    borderRadius: radius.full,
    paddingHorizontal: space.lg,
  },
  label: {
    ...type.bodyBold,
    textAlign: 'center',
  },
  compactLabel: { ...type.bodySm, fontWeight: '600' },
});

const COMPACT_SLOP = (touch.min - sizes.control) / 2;

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  size = 'regular',
  testID,
}: ButtonProps): React.JSX.Element {
  const inert = disabled || busy;
  const compact = size === 'compact';
  const press = usePressScale(!inert);

  return (
    // The scale lives on a wrapper because Pressable's style function cannot carry an animated value.
    <Animated.View style={press.style}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: inert, busy }}
        // Gate the handler here rather than leaning on Pressable's own `disabled` behaviour: an
        // unwired `onPress` is a fact a test can witness, and it is what stops a double-tap from
        // firing a second command in the frame before `busy` re-renders (§3.1).
        onPress={inert ? undefined : onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        disabled={inert}
        android_ripple={{ color: color.overlay, borderless: false }}
        hitSlop={compact ? { top: COMPACT_SLOP, bottom: COMPACT_SLOP } : undefined}
        style={({ pressed }) => [
          styles.base,
          compact ? styles.compact : null,
          variant === 'secondary' ? styles.secondaryOutline : null,
          // `disabled` wins over `busy` for fill: a disabled button is inert-looking, a busy one
          // keeps its identity while it works.
          {
            backgroundColor: disabled
              ? color.surfaceAlt
              : FILL[variant][pressed ? 'pressed' : 'default'],
          },
        ]}
      >
        {busy ? (
          // Width-stable by construction (§3.1): the row keeps its `paddingHorizontal` and any width
          // the caller set, and the spinner simply takes the label's place in the same flex row.
          <ActivityIndicator
            testID={testID === undefined ? undefined : `${testID}.spinner`}
            color={disabled ? color.textDisabled : LABEL_COLOR[variant]}
          />
        ) : (
          <Text
            testID={testID === undefined ? undefined : `${testID}.label`}
            // §3.1: labels wrap to 2 lines rather than truncate — ID/EN length variance (§0).
            numberOfLines={compact ? 1 : 2}
            style={[
              compact ? styles.compactLabel : styles.label,
              { color: disabled ? color.textDisabled : LABEL_COLOR[variant] },
            ]}
          >
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}
