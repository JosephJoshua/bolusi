/**
 * PatternLock — the Android 3 x 3 unlock pattern, drawn with a finger the way the customer draws
 * it on their phone, or shown read-only. Dots are numbered 1-9 from the top left and the value is
 * the dots in drawing order ("15963"). As on Android, passing over the dot between two others
 * takes it in, and each dot is used once. Drawn dots show their order, so a pattern read off a
 * ticket says where it starts.
 *
 * Without `onChange` it only shows `value`. Drawing commits on release; the caller decides whether
 * a short pattern is acceptable.
 */
import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { useScrollLock } from '../shell/scroll-lock.js';
import { color, radius, space, type } from '../tokens.js';

export interface PatternLockProps {
  /** Dots 1-9 in drawing order; '' for none. */
  readonly value: string;
  /** Absent: read-only. */
  readonly onChange?: ((value: string) => void) | undefined;
  /** Width and height in dp. */
  readonly size?: number | undefined;
  /** Already-localized, read before the steps ("Pola: 1-5-9-6"). */
  readonly accessibilityLabel: string;
  readonly testID?: string | undefined;
}

const DEFAULT_SIZE = 240;
const LINE = 6;

interface Point {
  readonly x: number;
  readonly y: number;
}

function centre(dot: number, cell: number): Point {
  const index = dot - 1;
  return { x: ((index % 3) + 0.5) * cell, y: (Math.floor(index / 3) + 0.5) * cell };
}

/** The dot under a point, when close enough to its centre. */
function dotAt(point: Point, cell: number): number | null {
  const col = Math.floor(point.x / cell);
  const row = Math.floor(point.y / cell);
  if (col < 0 || col > 2 || row < 0 || row > 2) return null;
  const dot = row * 3 + col + 1;
  const c = centre(dot, cell);
  return Math.hypot(point.x - c.x, point.y - c.y) <= cell * 0.38 ? dot : null;
}

/** The dot exactly between two others (1 and 3 → 2; 1 and 9 → 5), if there is one. */
function between(a: number, b: number): number | null {
  const [ar, ac] = [Math.floor((a - 1) / 3), (a - 1) % 3];
  const [br, bc] = [Math.floor((b - 1) / 3), (b - 1) % 3];
  if ((ar + br) % 2 !== 0 || (ac + bc) % 2 !== 0) return null;
  return ((ar + br) / 2) * 3 + (ac + bc) / 2 + 1;
}

function Segment({ from, to }: { from: Point; to: Point }): React.JSX.Element {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.line,
        {
          width: length,
          left: (from.x + to.x) / 2 - length / 2,
          top: (from.y + to.y) / 2 - LINE / 2,
          transform: [{ rotate: `${angle}rad` }],
        },
      ]}
    />
  );
}

export function PatternLock({
  value,
  onChange,
  size = DEFAULT_SIZE,
  accessibilityLabel,
  testID = 'ui.patternLock',
}: PatternLockProps): React.JSX.Element {
  const cell = size / 3;
  const [drawing, setDrawing] = useState<{ dots: string; finger: Point | null } | null>(null);
  const start = useRef<Point>({ x: 0, y: 0 });
  const dots = useRef('');
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  // The page must hold still under a drawing finger (on Android the ScrollView would take over).
  const scrollLock = useScrollLock();
  const unlock = useRef<(() => void) | null>(null);
  const release = (): void => {
    unlock.current?.();
    unlock.current = null;
  };

  const add = (point: Point): void => {
    const dot = dotAt(point, cell);
    if (dot === null || dots.current.includes(String(dot))) return;
    const last = dots.current.at(-1);
    const middle = last === undefined ? null : between(Number(last), dot);
    if (middle !== null && !dots.current.includes(String(middle))) dots.current += String(middle);
    dots.current += String(dot);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => changeRef.current !== undefined,
      onMoveShouldSetPanResponder: () => changeRef.current !== undefined,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (event: GestureResponderEvent) => {
        // The touch lands on the surface over the whole grid, so the location is the grid's.
        start.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
        dots.current = '';
        unlock.current ??= scrollLock.lock();
        add(start.current);
        setDrawing({ dots: dots.current, finger: start.current });
      },
      onPanResponderMove: (_event, gesture) => {
        const finger = { x: start.current.x + gesture.dx, y: start.current.y + gesture.dy };
        add(finger);
        setDrawing({ dots: dots.current, finger });
      },
      onPanResponderRelease: () => {
        release();
        setDrawing(null);
        if (dots.current !== '') changeRef.current?.(dots.current);
      },
      onPanResponderTerminate: () => {
        release();
        setDrawing(null);
      },
    }),
  ).current;

  const shown = drawing?.dots ?? value;
  const order = [...shown].map(Number);
  const lastDot = order.at(-1);
  const dotSize = Math.round(cell * 0.3);

  return (
    <View
      style={[styles.grid, { width: size, height: size }]}
      accessibilityLabel={
        value === '' ? accessibilityLabel : `${accessibilityLabel}: ${[...value].join('-')}`
      }
      accessible
      testID={testID}
    >
      {order.slice(1).map((dot, i) => (
        <Segment key={`${order[i]}-${dot}`} from={centre(order[i]!, cell)} to={centre(dot, cell)} />
      ))}
      {drawing?.finger != null && lastDot !== undefined ? (
        <Segment from={centre(lastDot, cell)} to={drawing.finger} />
      ) : null}
      {Array.from({ length: 9 }, (_, i) => {
        const dot = i + 1;
        const at = centre(dot, cell);
        const step = order.indexOf(dot);
        const on = step >= 0;
        return (
          <View
            key={dot}
            pointerEvents="none"
            testID={`${testID}.dot.${dot}`}
            style={[
              styles.dot,
              {
                width: dotSize,
                height: dotSize,
                left: at.x - dotSize / 2,
                top: at.y - dotSize / 2,
                backgroundColor: on ? color.primary : color.border,
              },
            ]}
          >
            {on ? <Text style={styles.step}>{step + 1}</Text> : null}
          </View>
        );
      })}
      {/* Last, so it is on top: the one view touched, never redrawn while a finger draws (the web
          ends a gesture whose target view is removed). */}
      <View {...responder.panHandlers} style={StyleSheet.absoluteFill} />
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    marginTop: space.sm,
  },
  line: {
    position: 'absolute',
    height: LINE,
    borderRadius: LINE / 2,
    backgroundColor: color.primary,
    opacity: 0.45,
  },
  dot: {
    position: 'absolute',
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  step: { ...type.caption, color: color.onPrimary, fontWeight: '700' },
});
