/**
 * SegmentedControl — one choice from a short, fixed set (how a payment came in, which paper, a
 * board's views, a checklist item's state). Every option shows its whole label and the picked one is
 * announced as `selected`, so the state never rides on colour alone (§6.3).
 *
 * Three layouts:
 * - `fill` (default), an answer in a form or a place's sections: the options share the full width in
 *   equal cells, as many to a row as fit every label on one line, so short answers sit in one row
 *   across the screen and long ones fall to two columns or a stack. A row the options do not fill
 *   stretches its cells, so the control always ends on the content's right edge (`OptionGrid`).
 * - `scroll`, a list's views with counts ("Antrean (12)"): one compact row that scrolls sideways in
 *   a `ChipRow`, so a long set keeps one line's height; the edge with more fades, and the picked
 *   option is scrolled into sight.
 * - `inline`, a few short options beside a label (a condition check's state): a plain row sized to
 *   its options whose pills never shrink; the caller stacks it under its label when it does not fit.
 *
 * `compact` is for a control that is not the screen's subject: a 36 dp option whose hit area is
 * still padded to the 48 dp floor, so it does not outweigh the content it filters.
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { ChipRow, useRevealInRow } from './ChipRow.js';
import { OptionGrid, type GridOption } from './OptionGrid.js';
import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';

/** Grows a compact pill's touch height to the §1.4 floor without growing what is drawn. */
const COMPACT_SLOP = (touch.min - sizes.control) / 2;

export type SegmentedOption<V extends string> = GridOption<V>;

export interface SegmentedControlProps<V extends string> {
  readonly options: readonly SegmentedOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  readonly layout?: 'fill' | 'scroll' | 'inline' | undefined;
  readonly size?: 'regular' | 'compact' | undefined;
  /**
   * `scroll` only: run the row through the screen's side padding (AppShell content, `space.lg`) to
   * the screen edges, so a pill cut off at the edge shows there are more to swipe to.
   */
  readonly bleed?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  row: { gap: touch.gap },
  option: {
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactOption: {
    minHeight: sizes.control,
    paddingHorizontal: space.md,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // No lineHeight on a pill's one line of text: with it, Android 15+ dropped the last word of
  // "Tidak dicek" while the measured box still held it (RN issue #57110; QA runs 1 to 5). The pill's
  // own height centres the text, so the line height adds nothing here.
  label: { fontSize: type.bodySm.fontSize, fontWeight: type.bodySm.fontWeight },
  compactLabel: { fontSize: type.caption.fontSize, fontWeight: '600' },
  inlineRow: { flexDirection: 'row', gap: touch.gap, flexShrink: 0 },
  inlineOption: { flexShrink: 0 },
});

export function SegmentedControl<V extends string>(
  props: SegmentedControlProps<V>,
): React.JSX.Element {
  const { layout = 'fill' } = props;
  if (layout !== 'fill') return <PillRow {...props} layout={layout} />;
  const { options, value, onChange, size, testID = 'ui.segmented' } = props;
  return (
    <OptionGrid
      options={options}
      isSelected={(option) => option === value}
      onPress={onChange}
      role="radio"
      size={size}
      testID={testID}
    />
  );
}

function PillRow<V extends string>({
  options,
  value,
  onChange,
  layout,
  size = 'regular',
  bleed = false,
  testID = 'ui.segmented',
}: SegmentedControlProps<V> & { readonly layout: 'scroll' | 'inline' }): React.JSX.Element {
  const compact = size === 'compact';
  const inline = layout === 'inline';
  const items = options.map((option) => {
    const selected = option.value === value;
    return (
      <Option
        key={option.value}
        selected={selected}
        testID={`${testID}.${option.value}`}
        accessibilityRole="radio"
        accessibilityLabel={option.label}
        accessibilityState={{ checked: selected, selected }}
        onPress={() => onChange(option.value)}
        hitSlop={compact ? { top: COMPACT_SLOP, bottom: COMPACT_SLOP } : undefined}
        style={[
          compact ? styles.compactOption : styles.option,
          inline ? styles.inlineOption : null,
          {
            backgroundColor: selected ? color.primary : color.surface,
            borderColor: selected ? color.primary : color.border,
          },
        ]}
      >
        <Text
          style={[
            compact ? styles.compactLabel : styles.label,
            { color: selected ? color.onPrimary : color.text },
          ]}
        >
          {option.label}
        </Text>
      </Option>
    );
  });
  if (inline) {
    return (
      <View style={styles.inlineRow} accessibilityRole="radiogroup" testID={testID}>
        {items}
      </View>
    );
  }
  return (
    <ChipRow bleed={bleed} contentStyle={styles.row} accessibilityRole="radiogroup" testID={testID}>
      {items}
    </ChipRow>
  );
}

/** One option's pressable; inside a scrolling row the picked one asks to be in sight. */
function Option({
  selected,
  ...props
}: React.ComponentProps<typeof Pressable> & { readonly selected: boolean }): React.JSX.Element {
  const reveal = useRevealInRow();
  const onLayout =
    selected && reveal !== null
      ? (event: LayoutChangeEvent) => {
          const { x, width } = event.nativeEvent.layout;
          reveal(x, width);
        }
      : undefined;
  return <Pressable {...props} onLayout={onLayout} />;
}
