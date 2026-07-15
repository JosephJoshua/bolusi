/**
 * UnauthorizedState (design-system §5, FR-1036).
 *
 * This component exists to make one mistake impossible: rendering permission-denial as emptiness.
 * §5 is explicit that a denied query returns a permission error, NOT an empty list, and that the
 * denial must neither masquerade as Empty nor leak what exists behind it.
 *
 * Hence: no item count, no entity names, no "3 notes hidden" — the body is a fixed, screen-supplied
 * guidance string ("ask your store owner") and a back CTA. There is deliberately no `onRetry`:
 * retrying a denial just denies again. Denial is logged at the command/query layer (FR-1045), not
 * here — a UI component is not an audit surface.
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, size, space, type } from '../tokens.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

export interface UnauthorizedStateProps {
  /** Already-localized: an explicit permission-denied title — never "nothing here". */
  readonly title: string;
  /** Already-localized guidance, e.g. "ask your store owner" (§5). */
  readonly hint?: string | undefined;
  /** Already-localized. §5: a back CTA, so denial is never a dead end. */
  readonly backLabel: string;
  readonly onBack: () => void;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  title: { ...type.heading, color: color.text, textAlign: 'center', marginTop: space.lg },
  hint: { ...type.bodySm, color: color.textMuted, textAlign: 'center', marginTop: space.sm },
  cta: { marginTop: space.xl, alignSelf: 'stretch' },
});

export function UnauthorizedState({
  title,
  hint,
  backLabel,
  onBack,
  testID = 'ui.unauthorizedState',
}: UnauthorizedStateProps): React.JSX.Element {
  return (
    <View testID={testID} style={styles.root}>
      <Icon name="unauthorized" size={size.iconState} color={color.textMuted} />
      <Text testID={`${testID}.title`} numberOfLines={2} style={styles.title}>
        {title}
      </Text>
      {hint === undefined ? null : (
        <Text testID={`${testID}.hint`} numberOfLines={2} style={styles.hint}>
          {hint}
        </Text>
      )}
      <View style={styles.cta}>
        <Button testID={`${testID}.back`} label={backLabel} onPress={onBack} variant="secondary" />
      </View>
    </View>
  );
}
