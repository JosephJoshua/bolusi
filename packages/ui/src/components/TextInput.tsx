/**
 * TextInput (design-system §3.2). Filled style, min height 56.
 *
 * The label is ALWAYS visible above the field. Placeholder-as-label is banned by §3.2 and the
 * reason is in §0: the placeholder vanishes the moment the user types, which is fatal for a
 * tech-inadept cashier who looks away mid-entry. `placeholder` here is example content only.
 *
 * MULTILINE IS AN ADDITIVE VARIANT, DEFAULT OFF. RN's `multiline` defaults to `false`, so every
 * field in this app was a one-line box that clips — fatal for §8.6's free-form note BODY, which is
 * the reference module's whole content. `multiline` is opt-in so PIN-adjacent, identifier, and
 * title fields keep the single-line contract they were written against.
 *
 * WHAT MULTILINE HAS TO DO, verified against the RN 0.86 TextInput docs rather than memory:
 *   - `textAlignVertical: 'top'` — RN's docs state multiline "aligns the text to the top on iOS,
 *     and centers it on Android". Android is the product's target (§0), so WITHOUT this the body's
 *     first line floats in the middle of the box and typing pushes it around. It is an Android-only
 *     STYLE prop (an alias for `verticalAlign`), so it belongs in the stylesheet, not the props.
 *   - `minHeight`/`maxHeight` instead of `numberOfLines` — in RN 0.86 `numberOfLines` sets the
 *     MAXIMUM number of lines a `TextInput` accepts, which would cap how much a mechanic can write.
 *     Heights size the box without limiting the text.
 *   - Scrolling past `maxHeight` is the platform's own: Android's EditText scrolls its content
 *     natively. `scrollEnabled` is deliberately NOT used — RN documents it as iOS only, so citing
 *     it here would be an iOS switch standing in for an Android guarantee (CLAUDE.md §2.11).
 */
import { useState } from 'react';
import { TextInput as RNTextInput, StyleSheet, Text, View } from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface TextInputProps {
  /** Already-localized. Always rendered above the field (§3.2). */
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** Already-localized example content — never a substitute for `label`. */
  readonly placeholder?: string | undefined;
  /**
   * Already-localized. Present ⇒ the field is in its `error` state: danger outline, message below,
   * AND an icon — never colour alone (§6.3).
   */
  readonly errorMessage?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** §3.2: numeric fields open numeric keyboards. */
  readonly keyboardType?: KeyboardTypeOptions | undefined;
  readonly secureTextEntry?: boolean | undefined;
  /** First field of a wizard step / PIN screen. Also how the Gallery shows a real `focused` field. */
  readonly autoFocus?: boolean | undefined;
  /**
   * Free-form prose that must WRAP rather than clip (§8.6 note body). Default `false` — every
   * existing single-line field keeps its exact behaviour. See the file header for why this needs
   * `textAlignVertical` and heights rather than `numberOfLines`.
   */
  readonly multiline?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  field: {
    minHeight: touch.primary,
    borderRadius: radius.sm,
    borderWidth: border.hairline,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.text,
  },
  /**
   * Layered OVER `field` only when `multiline` is set, so the single-line geometry is untouched.
   * `minHeight` wins over `field`'s 56 because it is larger; the vertical padding is explicit
   * because top-aligned text would otherwise sit on the field's border.
   */
  multilineField: {
    minHeight: size.fieldMultilineMin,
    maxHeight: size.fieldMultilineMax,
    paddingVertical: space.md,
    textAlignVertical: 'top',
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  errorText: { ...type.bodySm, color: color.danger, marginLeft: space.xs, flex: 1 },
});

export function TextInput({
  label,
  value,
  onChangeText,
  placeholder,
  errorMessage,
  disabled = false,
  keyboardType,
  secureTextEntry = false,
  autoFocus = false,
  multiline = false,
  testID = 'ui.textInput',
}: TextInputProps): React.JSX.Element {
  const hasError = errorMessage !== undefined;
  const [focused, setFocused] = useState(false);

  return (
    <View testID={testID}>
      <Text testID={`${testID}.label`} style={styles.label}>
        {label}
      </Text>

      <RNTextInput
        testID={`${testID}.field`}
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.textMuted}
        editable={!disabled}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoFocus={autoFocus}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.field,
          multiline ? styles.multilineField : null,
          {
            backgroundColor: disabled ? color.surface : color.surfaceAlt,
            // Error outranks focus (§3.2): a focused field with an error still reads as an error.
            // Both use `border.focus` width — only the colour distinguishes them, which is legal
            // here because the error ALSO carries an icon + message below (§6.3).
            borderColor: hasError ? color.danger : focused ? color.primary : color.border,
            borderWidth: hasError || focused ? border.focus : border.hairline,
            color: disabled ? color.textDisabled : color.text,
          },
        ]}
      />

      {hasError ? (
        <View testID={`${testID}.error`} style={styles.errorRow}>
          <Icon name="warning" size={size.iconChip} color={color.danger} />
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );
}
