/**
 * ToggleChip — an on/off choice among many that can be picked together (what came in with the
 * device: SIM tray, case, charger). A selected chip shows a check icon as well as the fill, so it
 * reads without colour (§6.3), and announces itself as `checked`. The check takes the room the
 * unselected chip pads its label with, so toggling never changes its width and a row of chips
 * stays put.
 */
import { Pressable, StyleSheet, Text } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface ToggleChipProps {
  /** Already-localized. */
  readonly label: string;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly testID?: string | undefined;
}

// What the check adds beside the label, split over both sides while it is hidden.
const CHECK_ROOM = (size.iconChip + space.xs) / 2;

const styles = StyleSheet.create({
  chip: {
    // Sized to its label: in a column it would otherwise stretch into something that reads as a field.
    alignSelf: 'flex-start',
    minHeight: touch.min,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  label: { ...type.bodySm },
});

export function ToggleChip({
  label,
  selected,
  onToggle,
  testID = 'ui.toggleChip',
}: ToggleChipProps): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onToggle}
      style={[
        styles.chip,
        {
          paddingHorizontal: selected ? space.md : space.md + CHECK_ROOM,
          backgroundColor: selected ? color.infoBg : color.surface,
          borderColor: selected ? color.primary : color.border,
        },
      ]}
    >
      {selected ? (
        <Icon name="check" size={size.iconChip} color={color.info} testID={`${testID}.check`} />
      ) : null}
      <Text style={[styles.label, { color: selected ? color.info : color.text }]}>{label}</Text>
    </Pressable>
  );
}
