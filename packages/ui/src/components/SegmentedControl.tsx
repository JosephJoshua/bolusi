/**
 * SegmentedControl — one choice from a short, fixed set (a board's views, a checklist item's
 * state). Every option shows its label; the selected one is filled, so the state never rides on
 * colour alone (§6.3): it is also announced as `selected`. Scrolls sideways in a `ChipRow` when the
 * labels do not fit a narrow phone or a large font, rather than truncating them: the edge with more
 * fades, and the picked option is scrolled into sight.
 *
 * `compact` is for a control that is not the screen's subject (a board's filters, a checklist row's
 * state): a 36 dp pill whose hit area is still padded to the 48 dp floor, so it does not outweigh
 * the content it filters.
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { ChipRow, useRevealInRow } from './ChipRow.js';
import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';

/** Grows a compact pill's touch height to the §1.4 floor without growing what is drawn. */
const COMPACT_SLOP = (touch.min - sizes.control) / 2;

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
  readonly size?: 'regular' | 'compact' | undefined;
  /**
   * Run the scrolling row through the screen's side padding (AppShell content, `space.lg`) to the
   * screen edges, so a pill cut off at the edge shows there are more to swipe to.
   */
  readonly bleed?: boolean | undefined;
  /**
   * A plain row sized to its options, no wrapping or scrolling: a few short options beside a label
   * (a condition check's state). Each pill keeps its text's width and never shrinks, so a label is
   * never cut; the caller stacks the row under its label when it does not fit beside it.
   */
  readonly inline?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  row: { gap: touch.gap },
  wrapped: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.gap },
  // Compact pills carry vertical slop; wrapped rows sit far enough apart that the slops never meet.
  compactWrapped: { rowGap: 2 * COMPACT_SLOP },
  // Android delivers no touch outside a ScrollView's bounds, so the slop lives inside the row.
  compactRow: { paddingVertical: COMPACT_SLOP },
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

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  wrap = false,
  size = 'regular',
  bleed = false,
  inline = false,
  testID = 'ui.segmented',
}: SegmentedControlProps<V>): React.JSX.Element {
  const compact = size === 'compact';
  const items = options.map((option) => {
    const selected = option.value === value;
    return (
      <Option
        key={option.value}
        selected={selected}
        testID={`${testID}.${option.value}`}
        // One choice of several: a radio in a radio group, so a screen reader says "1 of 3, selected".
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
          // A pill is one line by design and the layout gives it its text's full width (pills never
          // shrink). One line with `clip` keeps any draw-time rounding to a sliver, never a word.
          numberOfLines={1}
          ellipsizeMode="clip"
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
  if (wrap) {
    return (
      <View
        style={[styles.wrapped, compact ? styles.compactWrapped : null]}
        accessibilityRole="radiogroup"
        testID={testID}
      >
        {items}
      </View>
    );
  }
  return (
    <ChipRow
      bleed={bleed}
      contentStyle={[styles.row, compact ? styles.compactRow : null]}
      accessibilityRole="radiogroup"
      testID={testID}
    >
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
