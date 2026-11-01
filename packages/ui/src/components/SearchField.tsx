/**
 * SearchField — the search box at the top of a list. The one field without a visible label: the
 * magnifier and the placeholder already say what it is and what it searches, so a "Search" caption
 * above it would only repeat them (§3.2's always-visible label exists so a typed value keeps its
 * meaning; a search box's value IS the query). Screen readers still get `accessibilityLabel`.
 *
 * A clear button appears once something is typed, so going back to the whole list is one tap.
 *
 * The placeholder is drawn by us, not the input, so it wraps: at a large font "Cari nama, no. HP,
 * no. servisan" does not fit one line, and an input's own placeholder was cut to "Cari nama, no.
 * HP, no. ser", which no longer says what can be searched. The input stays one line.
 */
import { NativeTextInput as RNTextInput, Text } from '../text.js';
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
  // The field's height is the placeholder's while it shows (one or more lines), else one line.
  field: { flex: 1, minHeight: touch.min, marginLeft: space.sm, justifyContent: 'center' },
  placeholder: { ...type.bodySm, color: color.textMuted, paddingVertical: space.sm },
  input: {
    ...type.bodySm,
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    // No platform padding, so typed text starts where the placeholder does.
    paddingHorizontal: 0,
    paddingVertical: 0,
    textAlignVertical: 'center',
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
      <View style={styles.field}>
        {value === '' ? (
          <Text
            style={styles.placeholder}
            // The input's accessibilityLabel already says what it searches.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID={`${testID}.placeholder`}
          >
            {placeholder}
          </Text>
        ) : null}
        <RNTextInput
          ref={reveal.ref}
          onFocus={reveal.onFocus}
          testID={`${testID}.field`}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={placeholder}
          value={value}
          onChangeText={onChangeText}
          returnKeyType="search"
          autoCorrect={false}
          style={styles.input}
        />
      </View>
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
