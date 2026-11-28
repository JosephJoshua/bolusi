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
import { Text } from '../text.js';
import { Animated, Pressable, StyleSheet } from 'react-native';

import { useEntrance } from '../motion.js';
import { color, radius, size, space, touch, type } from '../tokens.js';
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
  /** False when the owner times it itself (Batalkan stays longer than a note). */
  readonly autoHide?: boolean | undefined;
  /** §3.7: the ONLY permitted action, and it is optional. Already-localized. */
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

/** A plain note carries no icon; a finished or failed event says so with one. */
const TONE: Record<ToastTone, { fg: string; icon: IconName } | null> = {
  neutral: null,
  success: { fg: color.inverseSuccess, icon: 'success' },
  danger: { fg: color.inverseDanger, icon: 'rejected' },
};

/** The action is drawn as compact as the text beside it and reaches the 48 dp target by slop. */
const ACTION_SLOP = (touch.min - (type.bodySm.lineHeight + space.sm * 2)) / 2;

// A dark bar, not a card: it stands apart from the light page without a shadow (§1.3), and its
// text, icon and action share one centre line.
const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.inverseSurface,
    borderRadius: radius.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.xs,
    minHeight: touch.min,
  },
  message: { ...type.bodySm, color: color.onInverse, flex: 1, paddingVertical: space.sm },
  action: {
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.xs,
  },
  actionPressed: { backgroundColor: 'rgba(255,255,255,0.12)' },
  actionLabel: { ...type.bodySm, fontWeight: '600', color: color.inverseAction },
});

export function Toast({
  message,
  tone = 'neutral',
  onHide,
  actionLabel,
  onAction,
  autoHide = true,
  testID = 'ui.toast',
}: ToastProps): React.JSX.Element {
  const mark = TONE[tone];

  useEffect(() => {
    if (!autoHide) return;
    const timer = setTimeout(onHide, TOAST_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [onHide, autoHide]);

  const entrance = useEntrance();

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="alert"
      // §3.7: toasts never block touch. `box-none` lets presses through the container while the
      // action inside stays tappable.
      pointerEvents="box-none"
      style={[styles.base, entrance]}
    >
      {mark === null ? null : <Icon name={mark.icon} size={size.iconInline} color={mark.fg} />}
      <Text testID={`${testID}.message`} style={styles.message}>
        {message}
      </Text>

      {actionLabel === undefined || onAction === undefined ? null : (
        <Pressable
          testID={`${testID}.action`}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          hitSlop={ACTION_SLOP}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionLabel}>{actionLabel}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}
