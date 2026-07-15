/**
 * ErrorState (design-system §5).
 *
 * §5 forbids a dead end: an error screen ALWAYS offers retry. It also forbids raw exception text —
 * the message is a label-catalog string keyed by `DomainError.code` (07-i18n §4.2), resolved by the
 * screen. The `errorCode` caption is the support handle: a cashier reads six characters down the
 * phone instead of describing a screenshot.
 *
 * The code is rendered verbatim and is NOT localized — it is an identifier (07-i18n §4.2: `code` is
 * the contract, `message` is developer-facing and never rendered).
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, size, space, type } from '../tokens.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

export interface ErrorStateProps {
  /** Already-localized: `t('core.errors.' + code)` (07-i18n §4.2). */
  readonly title: string;
  /** Already-localized elaboration. */
  readonly hint?: string | undefined;
  /** `DomainError.code` verbatim — an identifier for support, never translated. */
  readonly errorCode?: string | undefined;
  /** Already-localized. §5: retry is mandatory, never a dead end. */
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  title: { ...type.heading, color: color.text, textAlign: 'center', marginTop: space.lg },
  hint: { ...type.bodySm, color: color.textMuted, textAlign: 'center', marginTop: space.sm },
  code: { ...type.caption, color: color.textMuted, marginTop: space.sm },
  cta: { marginTop: space.xl, alignSelf: 'stretch' },
});

export function ErrorState({
  title,
  hint,
  errorCode,
  retryLabel,
  onRetry,
  testID = 'ui.errorState',
}: ErrorStateProps): React.JSX.Element {
  return (
    <View testID={testID} style={styles.root}>
      <Icon name="error" size={size.iconState} color={color.danger} />
      <Text testID={`${testID}.title`} numberOfLines={2} style={styles.title}>
        {title}
      </Text>
      {hint === undefined ? null : (
        <Text testID={`${testID}.hint`} numberOfLines={2} style={styles.hint}>
          {hint}
        </Text>
      )}
      {errorCode === undefined ? null : (
        <Text testID={`${testID}.code`} style={styles.code}>
          {errorCode}
        </Text>
      )}
      <View style={styles.cta}>
        <Button
          testID={`${testID}.retry`}
          label={retryLabel}
          onPress={onRetry}
          variant="secondary"
        />
      </View>
    </View>
  );
}
