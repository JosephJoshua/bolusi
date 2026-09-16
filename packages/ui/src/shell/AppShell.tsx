/**
 * AppShell (design-system §8.1) — the frame every screen sits in.
 *
 * ┌──────────────────────────────┐
 * │ Header (56): [back 48] Title │  title `type.title` (roots) / `type.heading` (details)
 * │           [SyncChip][Avatar] │  ← both always present, both 48 dp targets
 * ├──────────────────────────────┤
 * │ Banner slot (§3.6, max one)  │
 * ├──────────────────────────────┤
 * │ Content (scrolls, pad lg)    │  the ONLY scrolling region; header/action bar stay fixed
 * ├──────────────────────────────┤
 * │ Bottom action bar (optional) │  primary Button, 56 dp, thumb zone
 * └──────────────────────────────┘
 *
 * PURELY PRESENTATIONAL — props in, layout out. No navigation, no sync state, no store access:
 * that wiring is task 24's. The slots are `ReactNode` rather than data props so the shell never
 * grows an opinion about what a banner or a chip *is*.
 *
 * `banner` is a single node, not a list: §3.6 says exactly ONE banner is visible and the rest are
 * counted. `selectBanner` (components/Banner) is what turns many causes into that one node — the
 * shell just renders whatever won.
 *
 * Android hardware back must equal `onBack` (§8.1). That binding is navigation's job (task 24);
 * this component only surfaces the affordance.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon.js';
import { border, color, size, space, touch, type } from '../tokens.js';

export interface AppShellProps {
  /** Already-localized screen title. */
  readonly title: string;
  /** §8.1: list roots use `type.title`; detail screens use `type.heading`. */
  readonly titleVariant?: 'root' | 'detail' | undefined;
  /** Omit on roots that have nothing to go back to. */
  readonly onBack?: (() => void) | undefined;
  /** Already-localized accessibility label for the back control. */
  readonly backLabel?: string | undefined;
  /** §8.1: always present. Supply a `<SyncChip />`. */
  readonly syncChip: ReactNode;
  /**
   * §8.1: always present. Supply an `<AvatarButton />`. Apps may compose additional header-right
   * chrome into this slot (the notes root fills it with `[language chip][avatar]`); the shell keeps
   * one opaque slot and forms no opinion about its contents.
   */
  readonly avatar: ReactNode;
  /** §3.6 banner slot — at most one, already selected via `selectBanner`. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
  /** Bottom action bar: the screen's one primary Button, in the thumb zone (§0, §8.1). */
  readonly bottomAction?: ReactNode;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  header: {
    height: size.header,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  back: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRoot: { ...type.title, color: color.text, flex: 1, marginHorizontal: space.sm },
  titleDetail: { ...type.heading, color: color.text, flex: 1, marginHorizontal: space.sm },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: touch.gap },
  content: { flex: 1 },
  /**
   * `flexGrow` — NOT `flex` — is load-bearing (task 206). On a ScrollView's content container,
   * `flex: 1` would clamp the content to the viewport height and defeat scrolling entirely; the
   * screen would clip exactly as it did before. `flexGrow: 1` lets short content still fill the
   * viewport (so the centered empty / loading / error states stay centered) while tall content is
   * free to exceed it and scroll.
   */
  contentContainer: { flexGrow: 1, padding: space.lg },
  actionBar: {
    padding: space.lg,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
});

export function AppShell({
  title,
  titleVariant = 'root',
  onBack,
  backLabel,
  syncChip,
  avatar,
  banner,
  children,
  bottomAction,
  testID = 'ui.appShell',
}: AppShellProps): React.JSX.Element {
  return (
    <View testID={testID} style={styles.root}>
      <View testID={`${testID}.header`} style={styles.header}>
        {onBack === undefined ? null : (
          <Pressable
            testID={`${testID}.back`}
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={onBack}
            style={styles.back}
          >
            <Icon name="back" size={size.iconInline} color={color.text} />
          </Pressable>
        )}

        <Text
          testID={`${testID}.title`}
          // §0: buttons and titles wrap or ellipsize, never silently truncate mid-word; the title
          // is one line by §8.1 geometry, so tail-ellipsis is the honest fallback.
          numberOfLines={1}
          ellipsizeMode="tail"
          style={titleVariant === 'root' ? styles.titleRoot : styles.titleDetail}
        >
          {title}
        </Text>

        <View testID={`${testID}.headerRight`} style={styles.headerRight}>
          {syncChip}
          {avatar}
        </View>
      </View>

      {banner === undefined ? null : <View testID={`${testID}.bannerSlot`}>{banner}</View>}

      {/*
        Scrollable by default (task 206). The content slot was a plain padded View, and no screen
        supplied its own ScrollView, so on a small low-end screen — or at a raised OS font scale —
        anything taller than the viewport was clipped with no gesture to reach it. The RNW visual
        harness renders at a desktop viewport, which is why this never showed up there.
      */}
      <ScrollView
        testID={`${testID}.content`}
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        // The header/action bar are fixed chrome; only this slot scrolls, so a bounce at the edges
        // would read as the whole screen coming loose.
        bounces={false}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>

      {bottomAction === undefined ? null : (
        <View testID={`${testID}.actionBar`} style={styles.actionBar}>
          {bottomAction}
        </View>
      )}
    </View>
  );
}
