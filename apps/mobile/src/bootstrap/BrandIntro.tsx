/**
 * The opening moment: picks up the native splash where it stops and hands over to the app.
 *
 * It first draws exactly what the splash shows (the mark on the splash green), then hides the
 * native splash under it, so there is no blank frame while the database opens. While the app loads
 * the gold disc hops and lands on the b; once the first screen is laid out underneath, the mark
 * grows a touch as the cover fades away over it. Transform and opacity only, on the native driver.
 *
 * Reduce motion: the cover simply goes when the app is ready. The hop waits for the system to say
 * whether to reduce motion (a few milliseconds, never more than `ANSWER_WAIT_MS`) rather than skip
 * the intro by assuming.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';

import {
  BrandMark,
  NATIVE_DRIVER,
  brandMarkWidth,
  easeExit,
  motion,
  useReducedMotionAnswer,
} from '@bolusi/ui';
import { brandSplash } from '@bolusi/ui/brand';

/**
 * The mark's height on the splash: app.config.ts draws splash-icon.png (a 1024 square with the mark
 * 300/512 of its height) at `imageWidth: 200`.
 */
export const SPLASH_MARK_HEIGHT = (200 * 300) / 512;
/** How high the disc hops, as a share of the mark's height. */
const HOP = 0.2;
const HOP_MS = 320;
/** How long the native splash takes to go once hidden, before the disc may hop in view. */
const SPLASH_EXIT_MS = 150;
/** How long a ready app waits for a cover that never drew before it is simply removed. */
const NEVER_DRAWN_MS = 1_000;
/** The longest the cover waits for the reduce-motion answer before simply leaving. */
const ANSWER_WAIT_MS = 400;
/**
 * The hop's height over its time, sampled from a thrown ball's parabola (up to 0.45, down by 0.8),
 * so a linear clock gives a natural rise and fall. The rest is the landing.
 */
const HOP_TIME = [0, 0.15, 0.3, 0.45, 0.55, 0.65, 0.8, 1];
const HOP_HEIGHT = [0, 0.556, 0.889, 1, 0.918, 0.673, 0, 0];

const FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  cover: {
    ...FILL,
    backgroundColor: brandSplash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { width: brandMarkWidth(SPLASH_MARK_HEIGHT), height: SPLASH_MARK_HEIGHT },
  layer: { ...FILL },
});

export interface BrandIntroProps {
  /** The first screen is mounted and laid out under the cover, so it can be shown. */
  readonly ready: boolean;
  /** Hides the native splash once the cover is drawn over it. Absent on web and in tests. */
  readonly onCovered?: (() => void) | undefined;
}

export function BrandIntro({ ready, onCovered }: BrandIntroProps): React.JSX.Element | null {
  const answer = useReducedMotionAnswer();
  const [gaveUp, setGaveUp] = useState(false);
  const still = answer ?? (gaveUp ? true : null);
  const [covered, setCovered] = useState(false);
  // A second layout (a rotation) must not hide the splash again: read synchronously, not via state.
  const coveredOnce = useRef(false);
  const [hopped, setHopped] = useState(false);
  const [gone, setGone] = useState(false);
  const hop = useRef(new Animated.Value(0)).current;
  const leave = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!covered || still !== null) return;
    const timer = setTimeout(() => setGaveUp(true), ANSWER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [covered, still]);

  // The hop plays while the app is still loading, once the native splash has handed over: the UI
  // thread is free then. Played at "ready" it raced the first screen's mount, which holds the UI
  // thread on a cheap phone, and Android skipped straight to its end.
  useEffect(() => {
    if (!covered || hopped || still === null) return;
    if (still) {
      setHopped(true);
      return;
    }
    const animation = Animated.sequence([
      // The native splash takes a moment to go after it is told to.
      Animated.delay(SPLASH_EXIT_MS),
      Animated.timing(hop, {
        toValue: 1,
        duration: HOP_MS,
        easing: Easing.linear,
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished) setHopped(true);
    });
    return () => animation.stop();
  }, [covered, hopped, still, hop]);

  // A cover that is somehow never laid out must not hold the app hostage.
  useEffect(() => {
    if (!ready || covered) return;
    const timer = setTimeout(() => setGone(true), NEVER_DRAWN_MS);
    return () => clearTimeout(timer);
  }, [ready, covered]);

  // The fade starts once the first screen is laid out under the cover (`ready`) and the hop is
  // done.
  useEffect(() => {
    if (!ready || gone || !hopped) return;
    if (still !== false) {
      setGone(true);
      return;
    }
    const animation = Animated.timing(leave, {
      toValue: 1,
      duration: motion.duration.base,
      easing: easeExit,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start(({ finished }) => {
      if (finished) setGone(true);
    });
    return () => animation.stop();
  }, [ready, gone, hopped, still, leave]);

  if (gone) return null;

  const lift = -HOP * SPLASH_MARK_HEIGHT;
  return (
    <Animated.View
      testID="brand-intro"
      // Blocks touches only while the app is not there yet; a tap during the fade reaches the app.
      pointerEvents={ready ? 'none' : 'auto'}
      onLayout={() => {
        if (coveredOnce.current) return;
        coveredOnce.current = true;
        setCovered(true);
        onCovered?.();
      }}
      style={[
        styles.cover,
        { opacity: leave.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
      ]}
    >
      <Animated.View
        style={[
          styles.mark,
          {
            transform: [
              { scale: leave.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
            ],
          },
        ]}
      >
        {/* The b gives a little as the disc lands on it. */}
        <Animated.View
          style={[
            styles.layer,
            {
              transform: [
                {
                  scale: hop.interpolate({
                    inputRange: [0, 0.8, 0.9, 1],
                    outputRange: [1, 1, 0.965, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <BrandMark size={SPLASH_MARK_HEIGHT} tone="dark" parts={['ring', 'stem']} />
        </Animated.View>
        <Animated.View
          style={[
            styles.layer,
            {
              transform: [
                {
                  translateY: hop.interpolate({
                    inputRange: HOP_TIME,
                    outputRange: HOP_HEIGHT.map((share) => share * lift),
                  }),
                },
              ],
            },
          ]}
        >
          <BrandMark size={SPLASH_MARK_HEIGHT} tone="dark" parts={['disc']} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
