/**
 * Banner (design-system §3.6) — the ONE ambient escalation surface.
 *
 * This file owns two separable things:
 *   1. `selectBanner` — the pure §3.6 priority ladder. Given every active cause, exactly one wins.
 *   2. `Banner` — the presentational strip rendered in the AppShell banner slot.
 *
 * STALENESS THRESHOLDS ARE NOT HERE, BY DESIGN. 03-state-machines §8 is the sole numeric source
 * ("the numbers live ONLY there"). This component's input is the LEVEL NAME (`fresh|warning|stale`)
 * already derived by the caller. If you find yourself wanting `1 h` or `24 h` in this package, the
 * derivation is in the wrong layer.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, size, space, touch, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

/** Derived staleness level (03-state-machines §8). Thresholds owned there; names are the contract. */
export type StalenessLevel = 'fresh' | 'warning' | 'stale';

export type BannerVariant = 'info' | 'warning' | 'danger';

/**
 * Every thing that can raise a banner (§3.6). `staleness` carries the LEVEL, never an age.
 * `info` carries an `id` so a screen can track which one the user dismissed for the session.
 */
export type BannerCause =
  | { readonly kind: 'deviceRevoked' }
  | { readonly kind: 'userDeactivated' }
  | { readonly kind: 'rejectedOps' }
  | { readonly kind: 'staleness'; readonly level: StalenessLevel }
  | { readonly kind: 'conflictSurfaced' }
  | { readonly kind: 'info'; readonly id: string };

export interface SelectedBanner {
  readonly cause: BannerCause;
  readonly variant: BannerVariant;
  /** How many other causes lost. Rendered as the §3.6 "+N" affix. */
  readonly suppressedCount: number;
}

/**
 * The §3.6 priority ladder, lowest number wins:
 *   1 danger security (device revoked / user deactivated)
 *   2 danger rejected ops
 *   3 danger staleness (level `stale`)
 *   4 warning conflict surfaced
 *   5 warning staleness (level `warning`)
 *   6 info
 * `fresh` staleness raises nothing at all — quiet is a feature (§3.6).
 */
function rank(cause: BannerCause): { rank: number; variant: BannerVariant } | null {
  switch (cause.kind) {
    case 'deviceRevoked':
    case 'userDeactivated':
      return { rank: 1, variant: 'danger' };
    case 'rejectedOps':
      return { rank: 2, variant: 'danger' };
    case 'staleness':
      if (cause.level === 'stale') return { rank: 3, variant: 'danger' };
      if (cause.level === 'warning') return { rank: 5, variant: 'warning' };
      return null;
    case 'conflictSurfaced':
      return { rank: 4, variant: 'warning' };
    case 'info':
      return { rank: 6, variant: 'info' };
  }
}

/**
 * Exactly ONE banner is visible; the rest are counted, not stacked (§3.6). Ties keep the caller's
 * order — stable, so a re-render cannot flip which of two equal-rank causes is showing.
 */
export function selectBanner(causes: readonly BannerCause[]): SelectedBanner | null {
  const ranked = causes.flatMap((cause) => {
    const r = rank(cause);
    return r === null ? [] : [{ cause, ...r }];
  });
  if (ranked.length === 0) return null;

  let winner = ranked[0]!;
  for (const candidate of ranked) {
    if (candidate.rank < winner.rank) winner = candidate;
  }
  return {
    cause: winner.cause,
    variant: winner.variant,
    suppressedCount: ranked.length - 1,
  };
}

/** §3.6, revised: see the note at the render site — the real ID strings need three. */
export const BANNER_MESSAGE_LINES = 3;

const VARIANT = {
  info: { bg: color.infoBg, fg: color.info, icon: 'info' },
  warning: { bg: color.warningBg, fg: color.warning, icon: 'warning' },
  danger: { bg: color.dangerBg, fg: color.onDangerBg, icon: 'rejected' },
} as const satisfies Record<BannerVariant, { bg: string; fg: string; icon: IconName }>;

export interface BannerProps {
  readonly variant: BannerVariant;
  /** Already-localized message. */
  readonly message: string;
  /**
   * Replaces the default variant icon. Staleness banners pass `<FreshnessCell level={…} />` (§3.11)
   * so the escalation reads as ONE instrument getting worse, rather than three unrelated coloured
   * strips — which is what makes it feel like something real is happening.
   */
  readonly leadingGlyph?: ReactNode;
  /** §3.6 "+N" affix: how many causes are suppressed behind this one. */
  readonly suppressedCount?: number | undefined;
  /** Tapping the banner opens Sync Status, which lists everything (§3.6). */
  readonly onPress?: (() => void) | undefined;
  /** Optional single action button, already-localized. */
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  /**
   * `info` ONLY — dismissible for the session. Ignored for `warning`/`danger`: a danger banner
   * exposes no dismiss affordance while its cause persists (§3.6), and that is enforced here
   * rather than trusted to every caller.
   */
  readonly onDismiss?: (() => void) | undefined;
  /**
   * `warning` ONLY — collapses to a header dot. Re-expansion "next screen" (§3.6) is navigation
   * state, so this stays controlled: the screen resets `collapsed` on navigate (task 24).
   */
  readonly collapsed?: boolean | undefined;
  readonly onToggleCollapse?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  // radius 0 and full-width: it is a strip under the header, not a card (§3.6).
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: touch.min,
  },
  message: {
    ...type.bodySm,
    flex: 1,
    marginLeft: space.sm,
  },
  affix: {
    ...type.caption,
    marginLeft: space.sm,
  },
  affordance: {
    minWidth: touch.min,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    ...type.caption,
    marginLeft: space.sm,
  },
  dot: {
    width: size.bannerDot,
    height: size.bannerDot,
    borderRadius: radius.full,
  },
  dotTarget: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function Banner({
  variant,
  message,
  leadingGlyph,
  suppressedCount = 0,
  onPress,
  actionLabel,
  onAction,
  onDismiss,
  collapsed = false,
  onToggleCollapse,
  testID = 'ui.banner',
}: BannerProps): React.JSX.Element {
  const { bg, fg, icon } = VARIANT[variant];

  // §3.6 dismiss matrix, enforced here so no caller can hand a danger banner an escape hatch.
  const dismissible = variant === 'info' && onDismiss !== undefined;
  const collapsible = variant === 'warning' && onToggleCollapse !== undefined;

  if (collapsible && collapsed) {
    return (
      <Pressable
        testID={`${testID}.dot`}
        accessibilityRole="button"
        accessibilityLabel={message}
        onPress={onToggleCollapse}
        style={styles.dotTarget}
      >
        <View style={[styles.dot, { backgroundColor: fg }]} />
      </Pressable>
    );
  }

  return (
    <View testID={testID} accessibilityRole="alert" style={[styles.base, { backgroundColor: bg }]}>
      {leadingGlyph ?? <Icon name={icon} size={size.iconInline} color={fg} />}
      <Text
        testID={`${testID}.message`}
        // THREE lines, not the two §3.6 originally specified — changed in the doc with this code,
        // on evidence from the real catalog rather than lorem: `sync.banner.stale` in Indonesian is
        // "Sudah lama tidak terhubung. Data di layar ini bisa jauh tertinggal." (67 chars), which
        // already fills two lines of `bodySm` on a 360 dp screen and overflows them at the 1.3×
        // font scale §6.5 requires us to survive. Two lines would truncate the sentence that tells
        // a technician their data is stale — the one thing this product promises never to hide.
        numberOfLines={BANNER_MESSAGE_LINES}
        style={[styles.message, { color: fg }]}
      >
        {message}
      </Text>

      {suppressedCount > 0 ? (
        // "+N" is a numeric affix, not a translatable word (§3.6); tapping opens Sync Status.
        <Text testID={`${testID}.affix`} style={[styles.affix, { color: fg }]}>
          +{suppressedCount}
        </Text>
      ) : null}

      {onPress === undefined ? null : (
        <Pressable
          testID={`${testID}.open`}
          accessibilityRole="button"
          accessibilityLabel={message}
          onPress={onPress}
          style={styles.affordance}
        >
          <Icon name="chevron" size={size.iconInline} color={fg} />
        </Pressable>
      )}

      {actionLabel === undefined || onAction === undefined ? null : (
        <Pressable
          testID={`${testID}.action`}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={styles.affordance}
        >
          <Text numberOfLines={1} style={[styles.actionLabel, { color: fg }]}>
            {actionLabel}
          </Text>
        </Pressable>
      )}

      {collapsible ? (
        <Pressable
          testID={`${testID}.collapse`}
          accessibilityRole="button"
          accessibilityLabel={message}
          onPress={onToggleCollapse}
          style={styles.affordance}
        >
          <Icon name="chevron" size={size.iconInline} color={fg} />
        </Pressable>
      ) : null}

      {dismissible ? (
        <Pressable
          testID={`${testID}.dismiss`}
          accessibilityRole="button"
          accessibilityLabel={message}
          onPress={onDismiss}
          style={styles.affordance}
        >
          <Icon name="chevron" size={size.iconInline} color={fg} />
        </Pressable>
      ) : null}
    </View>
  );
}
