/**
 * Money on screen. `Amount` is a sum on its own (a total under its label, a row's price);
 * `AmountRow` is a label left and its amount right, as on the Kas summary and a payment list.
 * Both use tabular figures so amounts line up, and `formatMoney` keeps "Rp" with its figure.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatMoney, formatSignedMoney } from '@bolusi/i18n';

import { Text } from '../text.js';
import { border, color, numeric, space, touch, type } from '../tokens.js';
import { FreshGlow } from './FreshGlow.js';
import { Icon } from './Icon.js';

/** `struck`: a record that no longer counts (a cancelled payment). */
export type AmountTone = 'text' | 'muted' | 'danger' | 'struck';

export interface AmountProps {
  readonly value: number;
  /** `title` for the one sum a screen is about, `strong` for a total, `body` for a line. */
  readonly size?: 'title' | 'strong' | 'body' | undefined;
  /** Shows "+" on a positive change (a cash move, a price added). */
  readonly signed?: boolean | undefined;
  readonly tone?: AmountTone | undefined;
  readonly testID?: string | undefined;
}

export function Amount({
  value,
  size = 'body',
  signed = false,
  tone = 'text',
  testID,
}: AmountProps): React.JSX.Element {
  return (
    <Text style={[styles[size], toneStyle(tone)]} testID={testID}>
      {signed ? formatSignedMoney(value) : formatMoney(value)}
    </Text>
  );
}

export interface AmountRowProps {
  readonly label: string;
  /** A line under the label: who, which servisan, when. */
  readonly detail?: string | undefined;
  /** The amount, or the words for one ("Kurang Rp 5.000") when a number alone would mislead. */
  readonly value: number | string;
  readonly signed?: boolean | undefined;
  readonly tone?: AmountTone | undefined;
  /** A total: bold, and no line under it. */
  readonly strong?: boolean | undefined;
  /** Opens a step; the row shows a chevron. */
  readonly onPress?: (() => void) | undefined;
  /** The record the row shows: it glows once when another device changes it. */
  readonly freshId?: string | undefined;
  readonly testID: string;
}

export function AmountRow({
  label,
  detail,
  value,
  signed = false,
  tone = 'text',
  strong = false,
  onPress,
  freshId,
  testID,
}: AmountRowProps): React.JSX.Element {
  const shown =
    typeof value === 'string' ? value : signed ? formatSignedMoney(value) : formatMoney(value);
  const body: ReactNode = (
    <>
      {freshId === undefined ? null : <FreshGlow id={freshId} />}
      <View style={styles.rowText}>
        <Text style={strong ? styles.rowLabelStrong : styles.rowLabel}>{label}</Text>
        {detail === undefined || detail === '' ? null : (
          <Text style={styles.rowDetail}>{detail}</Text>
        )}
      </View>
      <Text
        style={[strong ? styles.strong : styles.rowValue, toneStyle(tone)]}
        testID={`${testID}.value`}
      >
        {shown}
      </Text>
      {onPress === undefined ? null : <Icon name="chevron" size={20} color={color.textMuted} />}
    </>
  );
  return onPress === undefined ? (
    <View style={[styles.row, strong && styles.totalRow]} testID={testID}>
      {body}
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

function toneStyle(tone: AmountTone) {
  return tone === 'text' ? null : styles[tone];
}

const styles = StyleSheet.create({
  title: { ...type.title, ...numeric, color: color.text },
  strong: { ...type.bodyBold, ...numeric, color: color.text },
  body: { ...type.bodySm, ...numeric, fontWeight: '600', color: color.text },
  muted: { color: color.textMuted },
  danger: { color: color.danger },
  struck: { color: color.textMuted, textDecorationLine: 'line-through' },
  row: {
    minHeight: touch.min,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  totalRow: { borderBottomWidth: 0 },
  pressed: { backgroundColor: color.surfaceAlt },
  rowText: { flex: 1 },
  rowLabel: { ...type.bodySm, color: color.text },
  rowLabelStrong: { ...type.bodyBold, color: color.text },
  rowDetail: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  rowValue: { ...type.bodySm, ...numeric, fontWeight: '600', color: color.text },
});
