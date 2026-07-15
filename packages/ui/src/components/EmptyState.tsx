/**
 * EmptyState (design-system §3.8, §5).
 *
 * Empty ≠ error ≠ unauthorized — three DISTINCT components, never substituted (§3.8, FR-1036).
 * They are separate files, not one component with a `kind` prop, precisely so that a screen cannot
 * render "nothing here" when the truth is "you are not allowed to see this". `UnauthorizedState`
 * is the one that must never be reachable from here.
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, size, space, type } from '../tokens.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

export interface EmptyStateProps {
  /** Already-localized. */
  readonly title: string;
  /** Already-localized, ≤ 2 lines (§3.8). */
  readonly hint?: string | undefined;
  /**
   * Already-localized CTA label. The CTA renders IFF `onCreate` is supplied — and supplying it is
   * the SCREEN's decision, made from the create permission (§3.8, §5). This component deliberately
   * knows nothing about permissions: putting that check here would put one copy of an authz rule in
   * the design system and another in the query layer (CLAUDE.md §2.8).
   */
  readonly createLabel?: string | undefined;
  readonly onCreate?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  title: { ...type.heading, color: color.text, textAlign: 'center', marginTop: space.lg },
  hint: { ...type.bodySm, color: color.textMuted, textAlign: 'center', marginTop: space.sm },
  cta: { marginTop: space.xl, alignSelf: 'stretch' },
});

export function EmptyState({
  title,
  hint,
  createLabel,
  onCreate,
  testID = 'ui.emptyState',
}: EmptyStateProps): React.JSX.Element {
  return (
    <View testID={testID} style={styles.root}>
      <Icon name="empty" size={size.iconState} color={color.textMuted} />
      <Text testID={`${testID}.title`} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      {hint === undefined ? null : (
        <Text testID={`${testID}.hint`} numberOfLines={2} style={styles.hint}>
          {hint}
        </Text>
      )}
      {onCreate === undefined || createLabel === undefined ? null : (
        <View style={styles.cta}>
          <Button
            testID={`${testID}.cta`}
            label={createLabel}
            onPress={onCreate}
            variant="primary"
          />
        </View>
      )}
    </View>
  );
}
