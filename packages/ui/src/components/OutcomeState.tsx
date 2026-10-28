/**
 * OutcomeState — a full-screen statement of where a flow ended up: "PIN kamu sudah diganti", "PIN
 * Budi terkunci". An icon in a tinted disc, a title, and a sentence on what it means or what to do
 * next. The screen's one action goes in the bottom bar, not here.
 *
 * The tone is carried by the icon as well as the colour (§6.3), and the text wraps, never truncates.
 *
 * Success is a tick that draws itself in the disc once the disc has landed (a payment received, a
 * PIN changed): the moment the work is done should feel done.
 */
import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { useEntrance, usePop, useWipe } from '../motion.js';
import { color, radius, size, space, type } from '../tokens.js';
import { Icon, type IconName } from './Icon.js';

export type OutcomeTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface OutcomeStateProps {
  readonly tone: OutcomeTone;
  readonly icon: IconName;
  /** Already-localized. */
  readonly title: string;
  /** Already-localized. */
  readonly message?: string | undefined;
  /** Optional extra content under the message (a quiet link, a detail). */
  readonly children?: ReactNode;
  readonly testID?: string | undefined;
}

const TONE: Record<OutcomeTone, { readonly bg: string; readonly fg: string }> = {
  success: { bg: color.successBg, fg: color.success },
  warning: { bg: color.warningBg, fg: color.warning },
  danger: { bg: color.dangerBg, fg: color.danger },
  neutral: { bg: color.surfaceAlt, fg: color.textMuted },
};

const DISC = size.iconState + space.xl;
/** The tick starts once the disc has mostly landed. */
const TICK_DELAY = 120;

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingTop: space['3xl'], paddingHorizontal: space.lg },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...type.title, color: color.text, textAlign: 'center', marginTop: space.xl },
  message: { ...type.body, color: color.textMuted, textAlign: 'center', marginTop: space.sm },
  words: { alignSelf: 'stretch', alignItems: 'center' },
  extra: { marginTop: space.lg, alignItems: 'center' },
});

export function OutcomeState({
  tone,
  icon,
  title,
  message,
  children,
  testID = 'ui.outcomeState',
}: OutcomeStateProps): React.JSX.Element {
  const { bg, fg } = TONE[tone];
  // The disc lands first; the words rise in under it, so the eye reads the outcome, then the words.
  const disc = usePop();
  const words = useEntrance();
  return (
    <View testID={testID} style={styles.root}>
      <Animated.View style={[styles.disc, { backgroundColor: bg }, disc]}>
        {icon === 'success' ? (
          <Tick color={fg} testID={`${testID}.tick`} />
        ) : (
          <Icon name={icon} size={size.iconState} color={fg} />
        )}
      </Animated.View>
      <Animated.View style={[styles.words, words]}>
        <Text testID={`${testID}.title`} accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {message === undefined ? null : (
          <Text testID={`${testID}.message`} style={styles.message}>
            {message}
          </Text>
        )}
        {children === undefined ? null : <View style={styles.extra}>{children}</View>}
      </Animated.View>
    </View>
  );
}

/** The success disc already circles it, so the tick goes in bare. */
function Tick({ color: tint, testID }: { readonly color: string; readonly testID: string }) {
  const wipe = useWipe(size.iconState, TICK_DELAY);
  return (
    <Animated.View testID={testID} style={wipe.window}>
      <Animated.View style={wipe.content}>
        <Icon name="check" size={size.iconState} color={tint} />
      </Animated.View>
    </Animated.View>
  );
}
