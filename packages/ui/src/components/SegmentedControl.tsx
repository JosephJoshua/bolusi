/**
 * SegmentedControl — one choice from a short, fixed set (a board's views, a checklist item's
 * state). Every option shows its label; the selected one is filled, so the state never rides on
 * colour alone (§6.3): it is also announced as `selected`. Scrolls sideways when the labels do not
 * fit a narrow phone, rather than truncating them.
 *
 * `compact` is for a control that is not the screen's subject (a board's filters, a checklist row's
 * state): a 36 dp pill whose hit area is still padded to the 48 dp floor, so it does not outweigh
 * the content it filters.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { border, color, radius, size as sizes, space, touch, type } from '../tokens.js';

/** Grows a compact pill's touch height to the §1.4 floor without growing what is drawn. */
const COMPACT_SLOP = (touch.min - sizes.control) / 2;

export interface SegmentedOption<V extends string> {
  readonly value: V;
  /** Already-localized. */
  readonly label: string;
  /**
   * `fill` only: what choosing this option means, tinting it when chosen (a check found "Rusak" reads
   * red at a glance). The label still says it, so the meaning never rides on colour alone.
   */
  readonly tone?: 'success' | 'danger' | undefined;
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
   * One connected track sharing the full width equally, no scrolling: for a short fixed set on its
   * own line (a condition check's state under its name). Overrides `wrap`, `size` and `bleed`.
   */
  readonly fill?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  // A ScrollView grows by default; inside a scrolling screen that stretched the options to fill it.
  scroller: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: touch.gap },
  wrapped: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.gap },
  // Compact pills carry vertical slop; wrapped rows sit far enough apart that the slops never meet.
  compactWrapped: { rowGap: 2 * COMPACT_SLOP },
  // Android delivers no touch outside a ScrollView's bounds, so the slop lives inside the row.
  compactRow: { paddingVertical: COMPACT_SLOP },
  bleedScroller: { marginHorizontal: -space.lg },
  bleedRow: { paddingHorizontal: space.lg },
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
  label: { ...type.bodySm },
  compactLabel: { ...type.caption, fontWeight: '600' },
  track: {
    flexDirection: 'row',
    minHeight: touch.min,
    padding: space.xs,
    gap: space.xs,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
  },
  segment: {
    flex: 1,
    borderRadius: radius.sm,
    borderWidth: border.hairline,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  segmentLabel: { ...type.caption, fontWeight: '600', textAlign: 'center' },
});

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  wrap = false,
  size = 'regular',
  bleed = false,
  fill = false,
  testID = 'ui.segmented',
}: SegmentedControlProps<V>): React.JSX.Element {
  if (fill) return <Track options={options} value={value} onChange={onChange} testID={testID} />;
  const compact = size === 'compact';
  const items = options.map((option) => {
    const selected = option.value === value;
    return (
      <Pressable
        key={option.value}
        testID={`${testID}.${option.value}`}
        // One choice of several: a radio in a radio group, so a screen reader says "1 of 3, selected".
        accessibilityRole="radio"
        accessibilityLabel={option.label}
        accessibilityState={{ checked: selected, selected }}
        onPress={() => onChange(option.value)}
        hitSlop={compact ? { top: COMPACT_SLOP, bottom: COMPACT_SLOP } : undefined}
        style={[
          compact ? styles.compactOption : styles.option,
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
      </Pressable>
    );
  });
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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.scroller, bleed ? styles.bleedScroller : null]}
      contentContainerStyle={[
        styles.row,
        compact ? styles.compactRow : null,
        bleed ? styles.bleedRow : null,
      ]}
      accessibilityRole="radiogroup"
      testID={testID}
    >
      {items}
    </ScrollView>
  );
}

/** Colours of a chosen segment, by what the choice means. */
const TONE = {
  neutral: { bg: color.surface, border: color.border, fg: color.text },
  success: { bg: color.successBg, border: color.success, fg: color.onSuccessBg },
  danger: { bg: color.dangerBg, border: color.danger, fg: color.onDangerBg },
} as const;

/** The `fill` variant: equal segments in one track, the chosen one raised and tinted. */
function Track<V extends string>({
  options,
  value,
  onChange,
  testID,
}: Pick<SegmentedControlProps<V>, 'options' | 'value' | 'onChange'> & {
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.track} accessibilityRole="radiogroup" testID={testID}>
      {options.map((option) => {
        const selected = option.value === value;
        const tone = TONE[option.tone ?? 'neutral'];
        return (
          <Pressable
            key={option.value}
            testID={`${testID}.${option.value}`}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected, selected }}
            onPress={() => onChange(option.value)}
            // The track's padding is part of each segment's touch area: 48 dp in all.
            hitSlop={{ top: space.xs, bottom: space.xs }}
            style={[
              styles.segment,
              selected ? { backgroundColor: tone.bg, borderColor: tone.border } : null,
            ]}
          >
            {/* Wraps rather than clips if a translation or a large font needs it (§9). */}
            <Text style={[styles.segmentLabel, { color: selected ? tone.fg : color.textMuted }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
