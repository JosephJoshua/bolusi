/**
 * ConfirmSheet (design-system §3.10) — the SINGLE sanctioned exception to the modal ban.
 *
 * Dialogs are effectively banned in v0: they trap tech-inadept users (unclear dismissal), break
 * Android back expectations, and float small targets. Anything bigger than one-tap confirmation is
 * a full-screen flow. So: no forms inside, no nesting, no stacking (§3.10).
 *
 * CANCEL SITS BELOW CONFIRM. That inversion of the usual order is deliberate and specified: the
 * bottom of the sheet is the thumb's resting position (§0 one-handed use), so the SAFE action gets
 * the position a misfire is most likely to hit. Do not "fix" this to match platform convention.
 *
 * Rendered as a plain absolute overlay rather than RN `Modal`: the owner mounts it, so there is no
 * second, invisible view hierarchy to reason about. Android hardware-back → cancel is navigation
 * wiring (§8.1), and belongs to the screen (task 24), not here.
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, overlayOpacity, radius, space, type } from '../tokens.js';
import { Button } from './Button.js';

export interface ConfirmSheetProps {
  /** Already-localized. */
  readonly title: string;
  /** Already-localized consequence text, ≤ 2 lines (§3.10). */
  readonly message?: string | undefined;
  /** Already-localized label for the destructive action. */
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  /** Already-localized label for the safe action. */
  readonly cancelLabel: string;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' },
  // The one place a scrim is allowed (§1.3 — no elevation/shadow tokens exist otherwise).
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: color.overlay,
    opacity: overlayOpacity,
  },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    padding: space.lg,
  },
  title: { ...type.heading, color: color.text },
  message: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  confirm: { marginTop: space.xl },
  cancel: { marginTop: space.md },
});

export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  onConfirm,
  cancelLabel,
  onCancel,
  testID = 'ui.confirmSheet',
}: ConfirmSheetProps): React.JSX.Element {
  return (
    <View testID={testID} style={styles.root}>
      <View testID={`${testID}.scrim`} style={styles.scrim} />
      <View style={styles.sheet}>
        <Text testID={`${testID}.title`} numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        {message === undefined ? null : (
          <Text testID={`${testID}.message`} numberOfLines={2} style={styles.message}>
            {message}
          </Text>
        )}
        <View style={styles.confirm}>
          <Button
            testID={`${testID}.confirm`}
            label={confirmLabel}
            onPress={onConfirm}
            variant="destructive"
          />
        </View>
        {/* Cancel last — see the header note on thumb-misfire safety (§3.10). */}
        <View style={styles.cancel}>
          <Button
            testID={`${testID}.cancel`}
            label={cancelLabel}
            onPress={onCancel}
            variant="secondary"
          />
        </View>
      </View>
    </View>
  );
}
