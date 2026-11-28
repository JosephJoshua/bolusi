/**
 * OptionGrid — answers laid out across the full width in equal cells, as many to a row as keep every
 * label on one line: short answers ("Tunai", "QRIS", "Transfer") share one row across the screen,
 * long ones ("Bagian yang diperbaiki berfungsi") fall to two columns or a stack. A row the options do
 * not fill stretches its cells, so the grid always ends on the content's right edge instead of
 * leaving half the screen empty beside a few pills.
 *
 * A picked cell is tinted with a check, like a picked `ToggleChip`, so it reads without colour.
 * `SegmentedControl` (one answer, radios) and `CheckGrid` (several, checkboxes) draw with it.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { Text } from '../text.js';
import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

/** Space between cells, across and down; wider than two cells' touch slop together. */
const GAP = touch.gap;
const PAD = space.sm;
/** Between the check (or tick box) and its label: room enough that they read as mark then words. */
const ICON_GAP = space.md;
/** What a cell adds around its label: side padding, the border and the room the check takes. */
const CELL_EXTRA = 2 * space.md + 2 * border.hairline + sizes.iconChip + ICON_GAP;

export interface GridOption<V extends string> {
  readonly value: V;
  /** Already-localized. */
  readonly label: string;
}

export interface OptionGridProps<V extends string> {
  readonly options: readonly GridOption<V>[];
  readonly isSelected: (value: V) => boolean;
  readonly onPress: (value: V) => void;
  /** `radio`: one answer of the set. `checkbox`: each cell on or off by itself. */
  readonly role: 'radio' | 'checkbox';
  /** `compact`: a 36 dp cell for a control that is not the screen's subject. */
  readonly size?: 'regular' | 'compact' | undefined;
  readonly testID: string;
}

/**
 * How many equal cells to a row: the most that keep every label on one line, then evened out so a
 * last row is not left with a lone cell when the rows could be balanced (5 → 3 + 2, not 4 + 1).
 */
export function gridColumns(width: number, widestCell: number, count: number): number {
  let columns = 1;
  for (let c = count; c > 1; c -= 1) {
    if ((width - (c - 1) * GAP) / c >= widestCell) {
      columns = c;
      break;
    }
  }
  const rows = Math.ceil(count / columns);
  return Math.ceil(count / rows);
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  // Laid out out of sight, so the grid knows each label's one-line width before it picks columns.
  measure: { position: 'absolute', top: 0, left: 0, opacity: 0 },
  measureText: { alignSelf: 'flex-start', fontWeight: '600' },
  cell: {
    // Before the labels are measured the cells share each row by their text; afterwards each takes
    // an equal basis and a short last row stretches.
    flexGrow: 1,
    minHeight: sizes.option,
    paddingHorizontal: PAD,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: border.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: ICON_GAP,
  },
  compactCell: { minHeight: sizes.control },
  // No lineHeight: Android 15+ drops the last word of a one-line label that has one (RN #57110).
  label: { fontSize: type.bodySm.fontSize, fontWeight: type.bodySm.fontWeight },
  compactLabel: { fontSize: type.caption.fontSize, fontWeight: '600' },
  // A label longer than the whole width at a large font wraps inside its cell instead of running off.
  cellLabel: { flexShrink: 1, textAlign: 'center' },
  // Several on their own: each cell reads as a line of a checklist, box first, text from the left.
  checkCell: { justifyContent: 'flex-start', paddingHorizontal: space.md },
  checkLabel: { textAlign: 'left' },
  box: {
    width: sizes.iconChip,
    height: sizes.iconChip,
    borderRadius: radius.xs,
    borderWidth: border.focus,
    borderColor: color.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxTicked: { backgroundColor: color.primary, borderColor: color.primary },
  picked: { color: color.info, fontWeight: '600' },
  unpicked: { color: color.text },
});

export function OptionGrid<V extends string>({
  options,
  isSelected,
  onPress,
  role,
  size = 'regular',
  testID,
}: OptionGridProps<V>): React.JSX.Element {
  const compact = size === 'compact';
  const labelStyle = compact ? styles.compactLabel : styles.label;
  const slop = (touch.min - (compact ? sizes.control : sizes.option)) / 2;
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<Readonly<Record<string, number>>>({});
  const widths = options.map((option) => measured[option.label] ?? -1);
  const ready = width > 0 && widths.every((w) => w >= 0);
  const columns = ready ? gridColumns(width, Math.max(...widths) + CELL_EXTRA, options.length) : 0;
  // Whole pixels: a fractional basis can push the last cell of a full row onto the next line.
  const basis = columns > 0 ? Math.floor((width - (columns - 1) * GAP) / columns) : undefined;

  return (
    <View
      style={styles.grid}
      accessibilityRole={role === 'radio' ? 'radiogroup' : undefined}
      testID={testID}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    >
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {options.map((option) => (
          <Text
            key={option.value}
            style={[labelStyle, styles.measureText]}
            onLayout={(event: LayoutChangeEvent) => {
              const w = Math.ceil(event.nativeEvent.layout.width);
              setMeasured((prev) =>
                prev[option.label] === w ? prev : { ...prev, [option.label]: w },
              );
            }}
          >
            {option.label}
          </Text>
        ))}
      </View>
      {options.map((option) => {
        const selected = isSelected(option.value);
        return (
          <Pressable
            key={option.value}
            testID={`${testID}.${option.value}`}
            accessibilityRole={role}
            accessibilityLabel={option.label}
            accessibilityState={
              role === 'radio' ? { checked: selected, selected } : { checked: selected }
            }
            onPress={() => onPress(option.value)}
            hitSlop={{ top: slop, bottom: slop }}
            style={[
              styles.cell,
              compact ? styles.compactCell : null,
              role === 'checkbox' ? styles.checkCell : null,
              basis === undefined ? null : { flexBasis: basis },
              {
                backgroundColor: selected ? color.infoBg : color.surface,
                borderColor: selected ? color.primary : color.border,
              },
            ]}
          >
            {role === 'checkbox' ? (
              <View style={[styles.box, selected ? styles.boxTicked : null]}>
                {selected ? (
                  <Icon
                    name="check"
                    size={sizes.iconChip - 2 * border.focus}
                    color={color.onPrimary}
                    testID={`${testID}.${option.value}.check`}
                  />
                ) : null}
              </View>
            ) : selected ? (
              <Icon
                name="check"
                size={sizes.iconChip}
                color={color.info}
                testID={`${testID}.${option.value}.check`}
              />
            ) : null}
            <Text
              style={[
                labelStyle,
                styles.cellLabel,
                role === 'checkbox' ? styles.checkLabel : null,
                selected ? styles.picked : styles.unpicked,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface CheckGridProps<V extends string> {
  readonly options: readonly GridOption<V>[];
  readonly selected: readonly V[];
  readonly onToggle: (value: V) => void;
  readonly size?: 'regular' | 'compact' | undefined;
  readonly testID?: string | undefined;
}

/**
 * CheckGrid — a short, fixed set of things each ticked on its own (the checks before a handover),
 * all in view across the width. A list the shop grows (colours, accessories) stays a `ChipRow` of
 * `ToggleChip`s instead, so it keeps one line's height however long it gets.
 */
export function CheckGrid<V extends string>({
  options,
  selected,
  onToggle,
  size,
  testID = 'ui.checkGrid',
}: CheckGridProps<V>): React.JSX.Element {
  return (
    <OptionGrid
      options={options}
      isSelected={(value) => selected.includes(value)}
      onPress={onToggle}
      role="checkbox"
      size={size}
      testID={testID}
    />
  );
}
