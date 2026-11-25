/**
 * TextButton — a secondary action that belongs to the content beside it ("Ganti" next to the
 * technician, "Ubah harga" in the price header, "Lihat semua" over a photo strip). It is drawn as
 * coloured text so it never competes with the screen's one primary Button; the hit area is still
 * padded to the 48 dp floor (§1.4).
 *
 * `danger` is for a final action kept out of the way (cancelling a repair): red text says what it
 * is without a solid red block that looks like the next step.
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet } from 'react-native';

import { color, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

export interface TextButtonProps {
  /** Already-localized. */
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: 'primary' | 'danger' | undefined;
  readonly icon?: IconName | undefined;
  readonly disabled?: boolean | undefined;
  /** Already-localized; when the visible label leans on what is beside it ("Ganti" → "Ganti teknisi"). */
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}

const SLOP = (touch.min - size.control) / 2;

const styles = StyleSheet.create({
  base: {
    minHeight: size.control,
    paddingHorizontal: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    flexShrink: 1,
  },
  // Wraps rather than cut when the room beside it runs out (a large font): labels never truncate.
  label: { ...type.bodySm, fontWeight: '600', flexShrink: 1 },
});

const TONE = { primary: color.primary, danger: color.danger } as const;

export function TextButton({
  label,
  onPress,
  tone = 'primary',
  icon,
  disabled = false,
  accessibilityLabel,
  testID,
}: TextButtonProps): React.JSX.Element {
  const fg = disabled ? color.textDisabled : TONE[tone];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      hitSlop={{ top: SLOP, bottom: SLOP }}
      style={({ pressed }) => [styles.base, { opacity: pressed ? 0.6 : 1 }]}
    >
      {icon === undefined ? null : <Icon name={icon} size={size.iconChip} color={fg} />}
      <Text
        testID={testID === undefined ? undefined : `${testID}.label`}
        style={[styles.label, { color: fg }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
