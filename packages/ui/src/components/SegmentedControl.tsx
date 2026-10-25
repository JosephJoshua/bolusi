/**
 * SegmentedControl — one choice from a short, fixed set (a board's views, a checklist item's
 * state). Every option shows its label; the selected one is filled, so the state never rides on
 * colour alone (§6.3): it is also announced as `selected`. Scrolls sideways when the labels do not
 * fit a narrow phone, rather than truncating them.
 */
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { border, color, radius, space, touch, type } from '../tokens.js';

export interface SegmentedOption<V extends string> {
  readonly value: V;
  /** Already-localized. */
  readonly label: string;
}

export interface SegmentedControlProps<V extends string> {
  readonly options: readonly SegmentedOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: touch.gap },
  option: {
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { ...type.bodySm },
});

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  testID = 'ui.segmented',
}: SegmentedControlProps<V>): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      testID={testID}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testID}.${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[
              styles.option,
              {
                backgroundColor: selected ? color.primary : color.surface,
                borderColor: selected ? color.primary : color.border,
              },
            ]}
          >
            <Text style={[styles.label, { color: selected ? color.onPrimary : color.text }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
