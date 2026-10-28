/**
 * ChoiceChips — pick one or several values from a list that grows: a category field (Kualitas:
 * Original, OEM, KW), or tags. The choices sit in one sideways-scrolling `ChipRow`, picked ones
 * first, and the last chip opens a field to add one the list doesn't have yet; enter adds it and
 * keeps the field open for the next, so a run of new values is typed without reaching for a button.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '../tokens.js';
import { ActionChip } from './ActionChip.js';
import { ChipRow } from './ChipRow.js';
import { TextInput } from './TextInput.js';
import { ToggleChip } from './ToggleChip.js';

export interface ChoiceChipsProps {
  /** Already-localized, above the chips. */
  readonly label: string;
  /** The choices offered, in order. Values already picked show even when not listed. */
  readonly options: readonly string[];
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
  /** Several at once; otherwise picking one replaces the last, and tapping it again clears it. */
  readonly multiple?: boolean | undefined;
  /** Already-localized: the chip that opens the add field ("Lainnya"). Absent: no adding. */
  readonly addLabel?: string | undefined;
  /** Already-localized: the add field's label ("Pilihan baru"). */
  readonly addFieldLabel?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly testID?: string | undefined;
}

/** Same value whatever its case and spacing. */
const keyOf = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

const styles = StyleSheet.create({
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  field: { marginTop: space.sm },
});

export function ChoiceChips({
  label,
  options,
  value,
  onChange,
  multiple = false,
  addLabel,
  addFieldLabel,
  maxLength,
  testID = 'ui.choiceChips',
}: ChoiceChipsProps): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  const picked = new Set(value.map(keyOf));
  const shown = [
    ...value,
    ...options.filter((option, i) => {
      const key = keyOf(option);
      return !picked.has(key) && options.findIndex((o) => keyOf(o) === key) === i;
    }),
  ];

  const toggle = (option: string): void => {
    const key = keyOf(option);
    if (picked.has(key)) onChange(value.filter((v) => keyOf(v) !== key));
    else onChange(multiple ? [...value, option] : [option]);
  };
  const addTyped = (): void => {
    const next = typed.trim().replace(/\s+/g, ' ');
    setTyped('');
    if (next === '') {
      setAdding(false);
      return;
    }
    const known = shown.find((option) => keyOf(option) === keyOf(next));
    if (known !== undefined) {
      if (!picked.has(keyOf(known))) toggle(known);
    } else {
      onChange(multiple ? [...value, next] : [next]);
    }
    // One value: done. Several: the field stays for the next.
    if (!multiple) setAdding(false);
  };

  return (
    <View testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <ChipRow testID={`${testID}.chips`}>
        {shown.map((option) => (
          <ToggleChip
            key={keyOf(option)}
            label={option}
            selected={picked.has(keyOf(option))}
            onToggle={() => toggle(option)}
            testID={`${testID}.option.${keyOf(option)}`}
          />
        ))}
        {addLabel === undefined || adding ? null : (
          <ActionChip
            label={addLabel}
            icon="add"
            accessibilityLabel={`${addLabel}, ${label}`}
            onPress={() => setAdding(true)}
            testID={`${testID}.add`}
          />
        )}
      </ChipRow>
      {adding ? (
        <View style={styles.field}>
          <TextInput
            label={addFieldLabel ?? addLabel ?? label}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={addTyped}
            onBlur={addTyped}
            maxLength={maxLength}
            autoCorrect={false}
            // Opened by a tap on "add": the person asked to type.
            autoFocus
            testID={`${testID}.field`}
          />
        </View>
      ) : null}
    </View>
  );
}
