/**
 * Motion helpers over the shared `motion` tokens. Everything here animates transform and opacity
 * on the native driver, so a running animation costs the JS thread nothing on a cheap phone.
 *
 * Someone who turned on "reduce motion" (Android "Remove animations", iOS "Reduce Motion") gets no
 * movement: entrances land at their end state and presses do not shrink.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform } from 'react-native';

import { motion, overlayOpacity } from './tokens.js';

/** react-native-web has no native driver; asking for one there only logs a warning. */
export const NATIVE_DRIVER = Platform.OS !== 'web';

export const easeEnter = Easing.bezier(...motion.easing.enter);
export const easeExit = Easing.bezier(...motion.easing.exit);

// One subscription for the whole app instead of one query per animated component, started when
// this module loads. Until the system answers, assume less motion: anything that mounts in those
// first milliseconds appears in place rather than animating against the person's setting.
let reduced = true;
const listeners = new Set<() => void>();

function setReduced(next: boolean): void {
  if (next === reduced) return;
  reduced = next;
  for (const listener of listeners) listener();
}

void AccessibilityInfo.isReduceMotionEnabled().then(setReduced, () => setReduced(false));
AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the system asks for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reduced);
}

export type EntranceFrom = 'below' | 'end' | 'start' | 'none';

export interface EntranceOptions {
  /** Where it arrives from; `none` only fades. */
  readonly from?: EntranceFrom | undefined;
  readonly distance?: number | undefined;
  readonly duration?: number | undefined;
}

/** 0 to 1 once, on mount; already 1 under reduced motion. */
function useArrival(duration: number): Animated.Value {
  const still = useReducedMotion();
  const progress = useRef(new Animated.Value(still ? 1 : 0)).current;

  useEffect(() => {
    if (still) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: easeEnter,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, still, duration]);

  return progress;
}

function arrivalStyle(
  progress: Animated.Value,
  from: EntranceFrom,
  distance: number,
): Animated.WithAnimatedValue<object> {
  if (from === 'none') return { opacity: progress };
  const offset = from === 'start' ? -distance : distance;
  const travel = progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] });
  return {
    opacity: progress,
    transform: [from === 'below' ? { translateY: travel } : { translateX: travel }],
  };
}

/**
 * An `Animated.View` style that brings a view in once, when it mounts: a fade plus a short move
 * from `from`. Give it a new `key` to play it again (the next step of a flow).
 */
export function useEntrance({
  from = 'below',
  distance = motion.distance.rise,
  duration = motion.duration.base,
}: EntranceOptions = {}): Animated.WithAnimatedValue<object> {
  const progress = useArrival(duration);
  return useMemo(() => arrivalStyle(progress, from, distance), [progress, from, distance]);
}

/**
 * A mark that lands with a small overshoot: the disc of a success screen, a fresh stamp. Plays once
 * on mount, after `delay`.
 */
export function usePop(delay = 0): Animated.WithAnimatedValue<object> {
  const still = useReducedMotion();
  const progress = useRef(new Animated.Value(still ? 1 : 0)).current;

  useEffect(() => {
    if (still) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.sequence([
      Animated.delay(delay),
      Animated.spring(progress, {
        toValue: 1,
        speed: 14,
        bounciness: 10,
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [progress, still, delay]);

  return useMemo(
    () => ({
      opacity: progress.interpolate({
        inputRange: [0, 0.5],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
    }),
    [progress],
  );
}

/**
 * A just-issued number landing like a rubber stamp: it comes down from a little larger and a
 * little turned, with a firm settle. Plays once on mount.
 */
export function useStamp(): Animated.WithAnimatedValue<object> {
  const still = useReducedMotion();
  const progress = useRef(new Animated.Value(still ? 1 : 0)).current;

  useEffect(() => {
    if (still) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.spring(progress, {
      toValue: 1,
      speed: 18,
      bounciness: 6,
      useNativeDriver: NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, still]);

  return useMemo(
    () => ({
      opacity: progress.interpolate({
        inputRange: [0, 0.3],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      transform: [
        { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1.6, 1] }) },
        { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['-8deg', '0deg'] }) },
      ],
    }),
    [progress],
  );
}

export interface PressScale {
  readonly style: Animated.WithAnimatedValue<object>;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

/** A pressed control shrinks a touch and springs back: feel under the thumb, not decoration. */
export function usePressScale(enabled = true): PressScale {
  const still = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const active = enabled && !still;

  const to = useCallback(
    (toValue: number, easing: (value: number) => number) => {
      if (!active) return;
      Animated.timing(scale, {
        toValue,
        duration: motion.duration.fast,
        easing,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    },
    [active, scale],
  );

  useEffect(() => {
    if (!active) scale.setValue(1);
  }, [active, scale]);

  return useMemo(
    () => ({
      style: { transform: [{ scale }] },
      onPressIn: () => to(motion.pressScale, easeExit),
      onPressOut: () => to(1, easeEnter),
    }),
    [scale, to],
  );
}

export interface SheetEntrance {
  /** For the scrim: fades up to `overlayOpacity`. */
  readonly scrim: Animated.WithAnimatedValue<object>;
  /** For the sheet: rises a short way while it fades in. */
  readonly sheet: Animated.WithAnimatedValue<object>;
}

/**
 * A bottom sheet arriving: the scrim dims the screen as the sheet slides up into its place. The
 * sheet itself never fades, so the screen behind never shows through its controls.
 */
export function useSheetEntrance(): SheetEntrance {
  const progress = useArrival(motion.duration.slow);
  return useMemo(
    () => ({
      scrim: {
        opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, overlayOpacity] }),
      },
      sheet: {
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [motion.distance.sheet, 0],
            }),
          },
        ],
      },
    }),
    [progress],
  );
}
