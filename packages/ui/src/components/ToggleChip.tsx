/**
 * ToggleChip — an on/off choice among many that can be picked together (what came in with the
 * device: SIM tray, case, charger). A selected chip shows a check icon as well as the fill, so it
 * reads without colour (§6.3), and announces itself as `checked`. The check takes the room the
 * unselected chip pads its label with, so toggling never changes its width and a row of chips
 * stays put.
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet } from 'react-native';

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
const CHECK_ROOM = (size.iconChip + space.sm) / 2;

/** Grows the 36 dp chip's touch height to the §1.4 floor without growing what is drawn. */
const CHIP_SLOP = (touch.min - size.control) / 2;

const styles = StyleSheet.create({
  chip: {
    // Sized to its label: in a column it would otherwise stretch into something that reads as a field.
    alignSelf: 'flex-start',
    // In a wrapped list (the handover checks) a label wider than the screen at a large font
    // wraps inside the chip instead of running off the edge. A sideways ChipRow never squeezes it.
    flexShrink: 1,
    // Drawn compact like a filter pill so a row of chips does not outweigh the fields around it;
    // the hit area is padded back to the 48 dp floor.
    minHeight: size.control,
    // Room above and below a label that took a second line.
    paddingVertical: space.xs,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: { ...type.bodySm, flexShrink: 1 },
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
      hitSlop={{ top: CHIP_SLOP, bottom: CHIP_SLOP }}
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
