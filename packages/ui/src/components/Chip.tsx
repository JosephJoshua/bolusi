/**
 * Chip (design-system §3.5). Icon + label, always — never colour alone (§6.3): a colourblind
 * cashier in a bright shop must lose nothing.
 *
 * The chip is 28 dp tall, below the 48 dp floor, so a tappable chip compensates with `hitSlop`
 * (§1.4: "a visual element may be smaller than 48 dp only if its pressable hit area still meets
 * `touch.min`"). That padding is computed from the tokens, not hand-tuned, so it stays correct if
 * either number ever moves.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

/** Tones are the §1.1 semantic pairs — each one is a contrast-validated fg/bg pair in `tokens.ts`. */
export type ChipTone = 'neutral' | 'warning' | 'danger' | 'success';

export interface ChipProps {
  /** Already-localized. */
  readonly label: string;
  readonly icon: IconName;
  readonly tone?: ChipTone | undefined;
  /** Present ⇒ the chip is pressable and gets a `button` role plus a `touch.min` hit area. */
  readonly onPress?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const TONE = {
  neutral: { bg: color.surfaceAlt, fg: color.textMuted },
  warning: { bg: color.warningBg, fg: color.warning },
  danger: { bg: color.dangerBg, fg: color.onDangerBg },
  success: { bg: color.successBg, fg: color.onSuccessBg },
} as const;

/** Grows the 28 dp chip's touch area to the §1.4 floor of 48 dp. */
const HIT_SLOP_Y = (touch.min - size.chip) / 2;

const styles = StyleSheet.create({
  base: {
    height: size.chip,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  label: {
    ...type.caption,
    marginLeft: space.xs,
  },
});

export function Chip({
  label,
  icon,
  tone = 'neutral',
  onPress,
  testID,
}: ChipProps): React.JSX.Element {
  const { bg, fg } = TONE[tone];
  const content = (
    <>
      <Icon name={icon} size={size.iconChip} color={fg} />
      <Text
        testID={testID === undefined ? undefined : `${testID}.label`}
        numberOfLines={1}
        style={[styles.label, { color: fg }]}
      >
        {label}
      </Text>
    </>
  );

  if (onPress === undefined) {
    return (
      <View testID={testID} style={[styles.base, { backgroundColor: bg }]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={{ top: HIT_SLOP_Y, bottom: HIT_SLOP_Y, left: HIT_SLOP_Y, right: HIT_SLOP_Y }}
      style={[styles.base, { backgroundColor: bg }]}
    >
      {content}
    </Pressable>
  );
}
