/**
 * ActionChip — a pill that does something rather than being picked: "Filter (2)", "Atur kategori",
 * "Lainnya". It sits in a `ChipRow` beside `ToggleChip`s at the same height, so a row of choices
 * can end (or start) with the action that belongs to it. Its icon and dashed outline tell it apart
 * from a choice without colour alone; `active` fills it when it stands for something switched on
 * (filters in force).
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

export interface ActionChipProps {
  /** Already-localized. */
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
  /** Already-localized, when the label alone is too short to say what it does. */
  readonly accessibilityLabel?: string | undefined;
  /** Filled, for an action that stands for something in force ("Filter (2)"). */
  readonly active?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    // Like ToggleChip: wraps its label rather than run off a narrow screen.
    flexShrink: 1,
    minHeight: touch.min,
    // Room above and below a label that took a second line.
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  label: { ...type.bodySm, flexShrink: 1 },
});

export function ActionChip({
  label,
  icon,
  onPress,
  accessibilityLabel,
  active = false,
  testID = 'ui.actionChip',
}: ActionChipProps): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? color.infoBg : color.surface,
          borderColor: active ? color.primary : color.border,
          borderStyle: active ? 'solid' : 'dashed',
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <Icon name={icon} size={size.iconChip} color={active ? color.info : color.primary} />
      <Text style={[styles.label, { color: active ? color.info : color.primary }]}>{label}</Text>
    </Pressable>
  );
}
