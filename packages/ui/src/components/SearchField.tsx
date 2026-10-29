/**
 * SearchField — the search box at the top of a list. The one field without a visible label: the
 * magnifier and the placeholder already say what it is and what it searches, so a "Search" caption
 * above it would only repeat them (§3.2's always-visible label exists so a typed value keeps its
 * meaning; a search box's value IS the query). Screen readers still get `accessibilityLabel`.
 *
 * A clear button appears once something is typed, so going back to the whole list is one tap.
 */
import { NativeTextInput as RNTextInput } from '../text.js';
import { Pressable, StyleSheet, View } from 'react-native';

import { useRevealOnFocus } from '../shell/keyboard.js';
import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface SearchFieldProps {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** Already-localized: what can be searched, e.g. "Cari nama, no. HP, no. servisan". */
  readonly placeholder: string;
  /** Already-localized: what a screen reader announces for the field. */
  readonly accessibilityLabel: string;
  /** Already-localized: the clear button's announced name. */
  readonly clearLabel: string;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  box: {
    minHeight: touch.min,
    borderRadius: radius.full,
    borderWidth: border.hairline,
    borderColor: color.surfaceAlt,
    backgroundColor: color.surfaceAlt,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.md,
  },
  input: {
    ...type.bodySm,
    flex: 1,
    minHeight: touch.min,
    marginLeft: space.sm,
    color: color.text,
  },
  clear: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Keeps the text from running under the rounded end when there is no clear button.
  endPad: { width: space.lg },
});

export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  clearLabel,
  testID = 'ui.searchField',
}: SearchFieldProps): React.JSX.Element {
  const reveal = useRevealOnFocus();
  return (
    <View testID={testID} style={styles.box}>
      <Icon name="search" size={size.iconInline} color={color.textMuted} />
      <RNTextInput
        ref={reveal.ref}
        onFocus={reveal.onFocus}
        testID={`${testID}.field`}
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textMuted}
        returnKeyType="search"
        autoCorrect={false}
        style={styles.input}
      />
      {value === '' ? (
        <View style={styles.endPad} />
      ) : (
        <Pressable
          testID={`${testID}.clear`}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          onPress={() => onChangeText('')}
          style={styles.clear}
        >
          <Icon name="clear" size={size.iconInline} color={color.textMuted} />
        </Pressable>
      )}
    </View>
  );
}
