/**
 * Button (design-system §3.1). Three variants × four mandatory states.
 *
 * There is deliberately NO `style` / `color` override prop. §1.1 fixes semantic meaning ("never
 * repurpose"), and an escape hatch is how a palette-closed system stops being closed: one screen
 * passes `color.danger` for emphasis and the meaning of red is gone app-wide. A new look = a new
 * variant = a design-system change first.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { border, color, radius, space, touch, type } from '../tokens.js';

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
    height: touch.primary,
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
  label: {
    ...type.bodyBold,
    textAlign: 'center',
  },
});

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  testID,
}: ButtonProps): React.JSX.Element {
  const inert = disabled || busy;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy }}
      // Gate the handler here rather than leaning on Pressable's own `disabled` behaviour: an
      // unwired `onPress` is a fact a test can witness, and it is what stops a double-tap from
      // firing a second command in the frame before `busy` re-renders (§3.1).
      onPress={inert ? undefined : onPress}
      disabled={inert}
      android_ripple={{ color: color.overlay, borderless: false }}
      style={({ pressed }) => [
        styles.base,
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
          numberOfLines={2}
          style={[styles.label, { color: disabled ? color.textDisabled : LABEL_COLOR[variant] }]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
