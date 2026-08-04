/**
 * The terminal panel a PIN-management flow shows after it settles (design-system §5/§3.7). Shared by
 * all three screens (change / reset / unlock) so a completed action reads the same everywhere
 * (CLAUDE.md §2.8): a success chip when it worked, the outcome sentence, and one button to leave or
 * act again.
 *
 * `tone: 'neutral'` is for truthful non-success endings that are NOT errors — an unlock of a user who
 * turned out to be no longer locked, say. It carries no success chip and no danger colour: the action
 * simply did not apply, and the message says so.
 */
import { Button, Chip, color, space, type } from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

export interface PinResultPanelProps {
  readonly tone: 'success' | 'neutral';
  /** The already-localized outcome sentence. */
  readonly message: string;
  /** The already-localized action-button label. */
  readonly actionLabel: string;
  readonly onAction: () => void;
  /** Label for the success chip (localized) — required when `tone` is `success`. */
  readonly chipLabel?: string | undefined;
  readonly testID?: string | undefined;
}

export function PinResultPanel({
  tone,
  message,
  actionLabel,
  onAction,
  chipLabel,
  testID,
}: PinResultPanelProps): React.JSX.Element {
  return (
    <View style={styles.panel} testID={testID}>
      {tone === 'success' && chipLabel !== undefined ? (
        <Chip
          label={chipLabel}
          icon="success"
          tone="success"
          testID={`${testID ?? 'pin-result'}-chip`}
        />
      ) : null}
      <Text style={styles.message}>{message}</Text>
      <Button
        label={actionLabel}
        variant="primary"
        onPress={onAction}
        testID={`${testID ?? 'pin-result'}-action`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: 'center',
    gap: space.lg,
    marginTop: space.xl,
  },
  message: {
    ...type.heading,
    color: color.text,
    textAlign: 'center',
  },
});
