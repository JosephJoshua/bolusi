/**
 * FreshGlow — a soft highlight behind a row or card that a colleague just changed, fading out over
 * a second so the eye catches what moved without anything jumping. Put it as the FIRST child of the
 * row so it sits behind the content; it fills its parent and never takes touches.
 *
 * Costs nothing at rest: it renders only once a change arrives, and the fade is opacity on the
 * native driver. Under reduced motion nothing glows.
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { useFresh, FRESH_MS } from '../fresh.js';
import { NATIVE_DRIVER, easeExit, useReducedMotion } from '../motion.js';
import { color } from '../tokens.js';

export interface FreshGlowProps {
  /** The record the row shows: the id another device's change names. */
  readonly id: string;
  /** The parent's corner radius, so the glow does not show square corners. */
  readonly radius?: number | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  glow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: color.infoBg,
  },
});

function Glow({ radius, testID }: Omit<FreshGlowProps, 'id'>): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: FRESH_MS,
      easing: easeExit,
      useNativeDriver: NATIVE_DRIVER,
    });
    fade.start();
    return () => fade.stop();
  }, [opacity]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      style={[styles.glow, radius === undefined ? null : { borderRadius: radius }, { opacity }]}
    />
  );
}

export function FreshGlow({ id, radius, testID }: FreshGlowProps): React.JSX.Element | null {
  const at = useFresh(id);
  const still = useReducedMotion();
  if (at === 0 || still) return null;
  // A new mark remounts the glow, so a second change a moment later glows again. Once faded it is
  // one transparent view until the row unmounts or the next change.
  return <Glow key={at} radius={radius} testID={testID} />;
}
