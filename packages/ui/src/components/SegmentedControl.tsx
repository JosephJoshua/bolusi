/**
 * SegmentedControl — one choice from a short, fixed set (a board's views, a checklist item's
 * state). Every option shows its label; the selected one is filled, so the state never rides on
 * colour alone (§6.3): it is also announced as `selected`. Scrolls sideways when the labels do not
 * fit a narrow phone, rather than truncating them.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
  /** Wrap onto more lines instead of scrolling sideways, so every choice stays in view. */
  readonly wrap?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  // A ScrollView grows by default; inside a scrolling screen that stretched the options to fill it.
  scroller: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: touch.gap },
  wrapped: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.gap },
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
  wrap = false,
  testID = 'ui.segmented',
}: SegmentedControlProps<V>): React.JSX.Element {
  const items = options.map((option) => {
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
  });
  if (wrap) {
    return (
      <View style={styles.wrapped} testID={testID}>
        {items}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.row}
      testID={testID}
    >
      {items}
    </ScrollView>
  );
}
