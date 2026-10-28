/**
 * QuantityStepper — how many of something: a minus button, the number, a plus button, as in a
 * shopping cart. Most counts are 1 or 2, so the buttons do the work; the number itself is also a
 * field for a count of 40 that nobody wants to tap out. The label sits above, as on every field.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput as RNTextInput, View } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface QuantityStepperProps {
  /** Already-localized, above the control. */
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** Already-localized accessible names for the two buttons ("Kurangi", "Tambah"). */
  readonly decreaseLabel: string;
  readonly increaseLabel: string;
  /** Already-localized, under the control (what is in stock). */
  readonly caption?: string | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  button: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    borderWidth: border.hairline,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
  input: {
    ...type.heading,
    minWidth: size.stepperValue,
    height: touch.min,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    color: color.text,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
});

export function QuantityStepper({
  label,
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  decreaseLabel,
  increaseLabel,
  caption,
  testID = 'ui.quantityStepper',
}: QuantityStepperProps): React.JSX.Element {
  // What is typed, kept apart from the value so a field cleared to retype is not forced back to min.
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((current) => (current === '' && value === min ? current : String(value)));
  }, [value, min]);
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  const step = (by: number): void => onChange(clamp(value + by));
  const canDecrease = value > min;
  const canIncrease = value < max;
  return (
    <View testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={decreaseLabel}
          accessibilityState={{ disabled: !canDecrease }}
          disabled={!canDecrease}
          onPress={() => step(-1)}
          style={[styles.button, canDecrease ? null : styles.disabled]}
          testID={`${testID}.decrease`}
        >
          <Icon name="decrease" size={size.iconInline} color={color.text} />
        </Pressable>
        <RNTextInput
          accessibilityLabel={label}
          keyboardType="number-pad"
          value={text}
          onChangeText={(typed) => {
            const digits = typed.replace(/[^0-9]/g, '');
            if (digits === '') {
              setText('');
              return;
            }
            // Out of range shows the nearest allowed number at once, so the box never reads
            // "0" while the value is 1.
            const next = clamp(Number(digits));
            setText(String(next));
            onChange(next);
          }}
          // An empty field on leaving is the smallest allowed, said back in the box.
          onBlur={() => {
            if (text === '') {
              setText(String(min));
              onChange(min);
            }
          }}
          selectTextOnFocus
          style={styles.input}
          testID={`${testID}.input`}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={increaseLabel}
          accessibilityState={{ disabled: !canIncrease }}
          disabled={!canIncrease}
          onPress={() => step(1)}
          style={[styles.button, canIncrease ? null : styles.disabled]}
          testID={`${testID}.increase`}
        >
          <Icon name="add" size={size.iconInline} color={color.text} />
        </Pressable>
      </View>
      {caption === undefined ? null : (
        <Text style={styles.caption} testID={`${testID}.caption`}>
          {caption}
        </Text>
      )}
    </View>
  );
}
