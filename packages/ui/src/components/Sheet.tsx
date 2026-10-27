/**
 * Sheet — a bottom sheet that shows more of what is already on the screen (every photo of a
 * repair), never a form or a decision: those are full-screen flows (§3.10), and a choice that needs
 * confirming is ConfirmSheet. It has a visible close button and closes on a tap on the scrim, so
 * nobody is trapped in it; the owner also closes it on hardware back.
 *
 * Mounted by its owner in the AppShell `overlay` slot, like ConfirmSheet.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NAV_BAR_INSET } from '../platform-insets.js';
import { useDismissKeyboard } from '../use-dismiss-keyboard.js';
import { color, overlayOpacity, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface SheetProps {
  /** Already-localized. */
  readonly title: string;
  /** Already-localized line under the title ("Pemilik Toko · Toko Utama"). */
  readonly subtitle?: string | undefined;
  /** Shown before the title: the avatar of the person an account menu belongs to. */
  readonly leading?: ReactNode;
  /** Already-localized label of the close button. */
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' },
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
    maxHeight: '85%',
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    paddingBottom: NAV_BAR_INSET,
  },
  handle: {
    alignSelf: 'center',
    width: space['2xl'],
    height: space.xs,
    borderRadius: radius.full,
    backgroundColor: color.border,
    marginTop: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.xs,
    minHeight: size.header,
  },
  leading: { marginRight: space.md },
  titles: { flex: 1, paddingVertical: space.sm },
  title: { ...type.heading, color: color.text },
  subtitle: { ...type.bodySm, color: color.textMuted },
  close: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg, paddingBottom: space.lg },
});

export function Sheet({
  title,
  subtitle,
  leading,
  closeLabel,
  onClose,
  children,
  testID = 'ui.sheet',
}: SheetProps): React.JSX.Element {
  // Like ConfirmSheet, it never opens under the keyboard.
  useDismissKeyboard();
  return (
    <View testID={testID} style={styles.root}>
      <Pressable
        testID={`${testID}.scrim`}
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        style={styles.scrim}
      />
      <View testID={`${testID}.sheet`} style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          {leading === undefined ? null : <View style={styles.leading}>{leading}</View>}
          <View style={styles.titles}>
            <Text style={styles.title} testID={`${testID}.title`}>
              {title}
            </Text>
            {subtitle === undefined ? null : (
              <Text style={styles.subtitle} testID={`${testID}.subtitle`}>
                {subtitle}
              </Text>
            )}
          </View>
          <Pressable
            testID={`${testID}.close`}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            onPress={onClose}
            style={styles.close}
          >
            <Icon name="close" size={size.iconInline} color={color.textMuted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      </View>
    </View>
  );
}
