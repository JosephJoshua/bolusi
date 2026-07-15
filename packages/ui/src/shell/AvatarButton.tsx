/**
 * AvatarButton (design-system §8.1) — the header's current-user affordance.
 *
 * It reinforces attribution on a SHARED device (PRD-011 §2): the person at the counter must see, at
 * a glance, who the app currently thinks they are BEFORE they append an operation under that
 * identity. That is a correctness surface, not a decoration — an op signed as the wrong technician
 * is not undoable (05 §1: a correction is a new operation).
 *
 * All identity rendering lives in `Avatar` (§3.12) — this is only the 48 dp target around it.
 */
import { Pressable, StyleSheet } from 'react-native';

import { Avatar } from '../components/Avatar.js';
import { radius, touch } from '../tokens.js';

export interface AvatarButtonProps {
  /** Stable user id — seeds the identity hue (§3.12). */
  readonly userId: string;
  /** Caller-computed initials, 1–2 characters. */
  readonly initials: string;
  /** Already-localized, e.g. "Ganti pengguna (Siti)". */
  readonly accessibilityLabel: string;
  /** §8.1: tap → User Switcher. */
  readonly onPress: () => void;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  base: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function AvatarButton({
  userId,
  initials,
  accessibilityLabel,
  onPress,
  testID = 'ui.avatarButton',
}: AvatarButtonProps): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.base}
    >
      <Avatar testID={`${testID}.avatar`} userId={userId} initials={initials} size="header" />
    </Pressable>
  );
}
