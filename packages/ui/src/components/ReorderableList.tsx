/**
 * ReorderableList — rows the user puts in order by dragging, like an iOS list in edit mode: press
 * a row's handle, drag it, and the other rows slide aside to show where it will land. Each row is
 * the caller's; it places the `handle` it is given (usually trailing) or leaves it out for a row
 * that cannot move right now (one open for editing).
 *
 * Built on RN's own `PanResponder` and `Animated`, like PhotoViewer: no gesture library. Inside a
 * scrolling AppShell the page holds still while a row is dragged (`useScrollLock`). The handle also
 * offers "move up" and "move down" as accessibility actions, so screen-reader and switch users can
 * reorder without dragging.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Platform, StyleSheet, View } from 'react-native';
import type { PanResponderInstance } from 'react-native';

import { useScrollLock } from '../shell/scroll-lock.js';
import { border, color, size, touch } from '../tokens.js';
import { Icon } from './Icon.js';

export interface ReorderableListProps<T> {
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  /** One row. `handle` is the drag handle to place in it; omit it to keep that row still. */
  readonly renderItem: (item: T, handle: ReactNode, index: number) => ReactNode;
  /** The row at `from` was dropped at `to` (indices into `items`). */
  readonly onMove: (from: number, to: number) => void;
  /** Already-localized accessibility label of each handle ("Geser untuk mengurutkan"). */
  readonly handleLabel: string;
  /** Already-localized names of the accessibility actions. */
  readonly moveUpLabel: string;
  readonly moveDownLabel: string;
  readonly testID?: string | undefined;
}

const NATIVE_DRIVER = Platform.OS !== 'web';
const SETTLE_MS = 150;

const styles = StyleSheet.create({
  lifted: { zIndex: 1 },
  liftedOutline: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderWidth: border.hairline * 2,
    borderColor: color.primary,
  },
  handle: {
    width: touch.min,
    height: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/** Where a row dragged `dy` from `from` lands: past the middle of a neighbour, it takes its place. */
export function dropIndex(heights: readonly number[], from: number, dy: number): number {
  let to = from;
  let passed = 0;
  const step = dy > 0 ? 1 : -1;
  for (let j = from + step; j >= 0 && j < heights.length; j += step) {
    const height = heights[j]!;
    if (Math.abs(dy) <= passed + height / 2) break;
    passed += height;
    to = j;
  }
  return to;
}

export function ReorderableList<T>({
  items,
  keyOf,
  renderItem,
  onMove,
  handleLabel,
  moveUpLabel,
  moveDownLabel,
  testID = 'ui.reorderableList',
}: ReorderableListProps<T>): React.JSX.Element {
  const scrollLock = useScrollLock();
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef(new Animated.Value(0)).current;
  const offsets = useRef(new Map<string, Animated.Value>()).current;
  const heights = useRef(new Map<string, number>()).current;
  const responders = useRef(new Map<string, PanResponderInstance>()).current;
  // The responders outlive renders; they read the latest props and state through this.
  const live = useRef({ items, keyOf, onMove, scrollLock });
  live.current = { items, keyOf, onMove, scrollLock };
  const gesture = useRef<{
    key: string;
    from: number;
    to: number;
    release: () => void;
  } | null>(null);
  // Set when a drop reordered the rows: the offsets reset once the new order has rendered, so the
  // dropped row never flashes back to its old place for a frame.
  const settling = useRef(false);

  const offsetOf = (key: string): Animated.Value => {
    let value = offsets.get(key);
    if (value === undefined) {
      value = new Animated.Value(0);
      offsets.set(key, value);
    }
    return value;
  };

  const resetOffsets = (): void => {
    drag.setValue(0);
    for (const value of offsets.values()) {
      value.stopAnimation();
      value.setValue(0);
    }
  };

  useLayoutEffect(() => {
    if (!settling.current) return;
    settling.current = false;
    resetOffsets();
  });

  // A list that goes away mid-drag (the screen closed under the finger) still frees the page scroll.
  useEffect(() => () => gesture.current?.release(), []);

  const keysNow = (): string[] => live.current.items.map(live.current.keyOf);

  const shift = (keys: readonly string[], from: number, to: number): void => {
    const moved = heights.get(keys[from]!) ?? 0;
    keys.forEach((key, j) => {
      if (j === from) return;
      const toValue = from < j && j <= to ? -moved : to <= j && j < from ? moved : 0;
      Animated.timing(offsetOf(key), {
        toValue,
        duration: SETTLE_MS,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    });
  };

  const finish = (drop: boolean): void => {
    const current = gesture.current;
    gesture.current = null;
    if (current === null) return;
    current.release();
    setDragging(null);
    const from = keysNow().indexOf(current.key);
    if (drop && from >= 0 && current.to !== from) {
      settling.current = true;
      live.current.onMove(from, current.to);
    } else {
      resetOffsets();
    }
  };

  const responderFor = (key: string): PanResponderInstance => {
    let responder = responders.get(key);
    if (responder !== undefined) return responder;
    responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Once a row is picked up, nothing (the page's scroll included) takes the touch away.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const from = keysNow().indexOf(key);
        if (from < 0) return;
        gesture.current = { key, from, to: from, release: live.current.scrollLock.lock() };
        setDragging(key);
      },
      onPanResponderMove: (_event, state) => {
        const current = gesture.current;
        if (current === null) return;
        drag.setValue(state.dy);
        const keys = keysNow();
        const to = dropIndex(
          keys.map((k) => heights.get(k) ?? 0),
          current.from,
          state.dy,
        );
        if (to !== current.to) {
          current.to = to;
          shift(keys, current.from, to);
        }
      },
      onPanResponderRelease: () => finish(true),
      onPanResponderTerminate: () => finish(false),
    });
    responders.set(key, responder);
    return responder;
  };

  return (
    <View testID={testID}>
      {items.map((item, index) => {
        const key = keyOf(item);
        const lifted = dragging === key;
        const handle = (
          <View
            {...responderFor(key).panHandlers}
            testID={`${testID}.handle.${key}`}
            accessible
            accessibilityLabel={handleLabel}
            accessibilityActions={[
              ...(index > 0 ? [{ name: 'moveUp', label: moveUpLabel }] : []),
              ...(index < items.length - 1 ? [{ name: 'moveDown', label: moveDownLabel }] : []),
            ]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'moveUp') onMove(index, index - 1);
              if (event.nativeEvent.actionName === 'moveDown') onMove(index, index + 1);
            }}
            style={styles.handle}
          >
            <Icon
              name="dragHandle"
              size={size.iconInline}
              color={lifted ? color.primary : color.textMuted}
            />
          </View>
        );
        return (
          <Animated.View
            key={key}
            testID={`${testID}.item.${key}`}
            onLayout={(event) => heights.set(key, event.nativeEvent.layout.height)}
            style={[
              lifted ? styles.lifted : null,
              { transform: [{ translateY: lifted ? drag : offsetOf(key) }] },
            ]}
          >
            {renderItem(item, handle, index)}
            {lifted ? <View pointerEvents="none" style={styles.liftedOutline} /> : null}
          </Animated.View>
        );
      })}
    </View>
  );
}
