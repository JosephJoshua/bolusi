/**
 * Toast (design-system §3.7) — BACKGROUND EVENTS ONLY.
 *
 * Read §3.7 before reaching for this. Toasts vanish before slow readers finish, so anything the
 * user must see or act on gets an inline error, a chip, or a banner instead. A validation error
 * from the user's own action is NEVER a toast. A rejected op is a banner + chip; a toast may
 * additionally announce it, but is never the only surface.
 *
 * The 4 s auto-hide is `onHide`-driven rather than self-unmounting: the owner decides what "one at
 * a time" means (§3.7 — toasts are never stacked), and a component that removed itself from the
 * tree would fight that.
 */
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

/** §3.7: a toast announces a background event finishing or failing — nothing else. */
export type ToastTone = 'neutral' | 'success' | 'danger';

/** §3.7 auto-hide. Exported so the owner's timer and this one cannot drift apart. */
export const TOAST_AUTO_HIDE_MS = 4_000;

export interface ToastProps {
  /** Already-localized. */
  readonly message: string;
  readonly tone?: ToastTone | undefined;
  /** Called after `TOAST_AUTO_HIDE_MS`. The owner unmounts us. */
  readonly onHide: () => void;
  /** §3.7: the ONLY permitted action, and it is optional. Already-localized. */
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const TONE: Record<ToastTone, { fg: string; icon: IconName }> = {
  neutral: { fg: color.text, icon: 'info' },
  success: { fg: color.success, icon: 'success' },
  danger: { fg: color.danger, icon: 'rejected' },
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surface,
    borderWidth: border.hairline,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: touch.min,
  },
  message: { ...type.bodySm, color: color.text, flex: 1, marginLeft: space.sm },
  action: { minHeight: touch.min, justifyContent: 'center', marginLeft: space.sm },
  actionLabel: { ...type.bodySm, color: color.primary },
});

export function Toast({
  message,
  tone = 'neutral',
  onHide,
  actionLabel,
  onAction,
  testID = 'ui.toast',
}: ToastProps): React.JSX.Element {
  const { fg, icon } = TONE[tone];

  useEffect(() => {
    const timer = setTimeout(onHide, TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [onHide]);

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      // §3.7: toasts never block touch. `box-none` lets presses through the container while the
      // action inside stays tappable.
      pointerEvents="box-none"
      style={styles.base}
    >
      <Icon name={icon} size={size.iconInline} color={fg} />
      <Text testID={`${testID}.message`} numberOfLines={2} style={styles.message}>
        {message}
      </Text>

      {actionLabel === undefined || onAction === undefined ? null : (
        <Pressable
          testID={`${testID}.action`}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={styles.action}
        >
          <Text style={styles.actionLabel}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}
