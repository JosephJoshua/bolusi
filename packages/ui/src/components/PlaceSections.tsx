/**
 * PlaceSections — the switch between a place's sections at the top of its screen (Servisan |
 * Harga, Stok | Belanja | Kiriman). One track across the full width, split evenly, with the picked
 * section raised on it: it reads as where you are, not as a filter to toggle. A label longer than
 * its share wraps onto a second line rather than being cut.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '../text.js';
import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';
import type { SegmentedOption } from './SegmentedControl.js';

/** The track's inset around the raised section; the touch area is padded back to the floor. */
const INSET = 3;
const SLOP = (touch.min - sizes.control - 2 * INSET) / 2;

export interface PlaceSectionsProps<V extends string> {
  readonly options: readonly SegmentedOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  readonly testID?: string | undefined;
}

export function PlaceSections<V extends string>({
  options,
  value,
  onChange,
  testID = 'ui.placeSections',
}: PlaceSectionsProps<V>): React.JSX.Element {
  return (
    <View style={styles.track} accessibilityRole="tablist" testID={testID}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            hitSlop={SLOP > 0 ? { top: SLOP, bottom: SLOP } : undefined}
            style={[styles.section, selected ? styles.selected : null]}
            testID={`${testID}.${option.value}`}
          >
            <Text style={[styles.label, selected ? styles.selectedLabel : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: INSET,
    gap: INSET,
    borderRadius: radius.sm + INSET,
    backgroundColor: color.surfaceAlt,
  },
  section: {
    flex: 1,
    minHeight: sizes.control,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: border.hairline,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: color.surface, borderColor: color.border },
  label: {
    fontSize: type.bodySm.fontSize,
    fontWeight: '600',
    color: color.textMuted,
    textAlign: 'center',
  },
  selectedLabel: { color: color.text },
});
