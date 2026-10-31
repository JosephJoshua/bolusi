/**
 * SwitchRow — a setting that is on or off, as on iOS and Android settings screens: the label on the
 * left, a switch on the right, and the whole row toggles it. For a choice between two named things
 * use SegmentedControl; for picking items in a group use ToggleChip.
 */
import { Text } from '../text.js';
import { Pressable, Switch, StyleSheet, View } from 'react-native';

import { color, space, touch, type } from '../tokens.js';

export interface SwitchRowProps {
  /** Already-localized. */
  readonly label: string;
  /** Already-localized, under the label (what the setting does, or why it is off). */
  readonly caption?: string | undefined;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly testID?: string | undefined;
}

// react-native-web paints an "on" thumb in its own teal unless given `activeThumbColor`, a prop
// RN's types don't know.
const WEB_THUMB = { activeThumbColor: color.surface } as object;

const styles = StyleSheet.create({
  row: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  texts: { flex: 1 },
  label: { ...type.bodySm, color: color.text },
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
});

export function SwitchRow({
  label,
  caption,
  value,
  onValueChange,
  testID = 'ui.switchRow',
}: SwitchRowProps): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={caption}
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={styles.row}
    >
      <View style={styles.texts}>
        <Text style={styles.label}>{label}</Text>
        {caption === undefined ? null : (
          <Text style={styles.caption} testID={`${testID}.caption`}>
            {caption}
          </Text>
        )}
      </View>
      {/* The row is the control; the switch only shows the state, so it takes no touches itself. */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Switch
          testID={`${testID}.switch`}
          value={value}
          trackColor={{ false: color.border, true: color.primary }}
          thumbColor={color.surface}
          ios_backgroundColor={color.border}
          {...WEB_THUMB}
        />
      </View>
    </Pressable>
  );
}
