/**
 * ChipRow — a row of choice chips that scrolls sideways, for lists whose length the shop or the
 * catalog decides (colours, quick brands, accessories) and for a board's views. Wrapped chips would
 * push the rest of the screen down by a line for every few choices; a row keeps one line's height
 * however many there are.
 *
 * It runs to the screen edges, and an edge with more to swipe to fades out. A chip that simply
 * stopped at the edge read as a label cut short (QA at the largest font: "Belum ada tek"), with no
 * sign that two more views sat past it; the fade says the row goes on. A chip that the row opens on
 * (`useRevealInRow`) is scrolled into sight, so a picked view past the edge is never hidden.
 */
import { createContext, useCallback, useContext, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';

import { color, space } from '../tokens.js';

export interface ChipRowProps {
  /** ToggleChip, ActionChip or Chip elements, in order. */
  readonly children: ReactNode;
  /**
   * Run through the screen's side padding (AppShell content, `space.lg`) to the screen edges.
   * Default on: a row inside a card or beside a label passes false.
   */
  readonly bleed?: boolean | undefined;
  /** Extra room around the chips inside the scroller (a compact control's touch slop). */
  readonly contentStyle?: StyleProp<ViewStyle>;
  /** What the row sits on, so the fade melts into it. */
  readonly background?: string | undefined;
  readonly accessibilityRole?: 'radiogroup' | undefined;
  readonly testID?: string | undefined;
}

/** The screen padding the row bleeds through (AppShell content uses `space.lg`). */
const BLEED = space.lg;
/** How far an edge fades: wide enough to read as "more", narrow enough to leave a chip readable. */
const FADE = space['2xl'];

const styles = StyleSheet.create({
  frame: { flexGrow: 0 },
  bleed: { marginHorizontal: -BLEED },
  // A ScrollView grows by default; inside a scrolling screen that stretched the row to fill it.
  scroller: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  bleedRow: { paddingHorizontal: BLEED },
  fade: { position: 'absolute', top: 0, bottom: 0, width: FADE },
  fadeStart: { left: 0 },
  fadeEnd: { right: 0 },
});

/** Lets a chip ask to be in sight when the row first lays it out (the picked view). */
const RevealContext = createContext<((x: number, width: number) => void) | null>(null);

/** For a chip inside a ChipRow: call with its layout to have the row scroll it into sight. */
export function useRevealInRow(): ((x: number, width: number) => void) | null {
  return useContext(RevealContext);
}

function EdgeFade({
  side,
  background,
  testID,
}: {
  readonly side: 'start' | 'end';
  readonly background: string;
  readonly testID: string;
}): React.JSX.Element {
  // A gradient id is a document-wide name on the web: one per row, in characters a url() accepts.
  const id = `chipRowFade${useId().replace(/[^A-Za-z0-9]/g, '')}${side}`;
  return (
    <View
      pointerEvents="none"
      style={[styles.fade, side === 'start' ? styles.fadeStart : styles.fadeEnd]}
      testID={testID}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={background} stopOpacity={side === 'start' ? 1 : 0} />
            <Stop offset="1" stopColor={background} stopOpacity={side === 'start' ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

export function ChipRow({
  children,
  bleed = true,
  contentStyle,
  background = color.surface,
  accessibilityRole,
  testID = 'ui.chipRow',
}: ChipRowProps): React.JSX.Element {
  const scroller = useRef<ScrollView>(null);
  const width = useRef(0);
  const content = useRef(0);
  const offset = useRef(0);
  const pending = useRef<{ x: number; width: number } | null>(null);
  const [more, setMore] = useState({ start: false, end: false });

  const update = useCallback(() => {
    // A pixel of rounding is not "more".
    const start = offset.current > 1;
    const end = content.current - offset.current - width.current > 1;
    setMore((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, []);

  const scrollToShow = useCallback((x: number, itemWidth: number) => {
    if (width.current === 0) {
      pending.current = { x, width: itemWidth };
      return;
    }
    pending.current = null;
    const left = offset.current;
    const right = left + width.current;
    // In sight means clear of the fades too, so its label reads whole. At rest there is no
    // start fade, so a first chip there is in sight as it is.
    const shownFrom = left > 1 ? left + FADE : left;
    if (x >= shownFrom && x + itemWidth + FADE <= right) return;
    const to = x < shownFrom ? x - FADE : x + itemWidth + FADE - width.current;
    scroller.current?.scrollTo({ x: Math.max(0, to), animated: false });
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.current = event.nativeEvent.layout.width;
      update();
      if (pending.current !== null) scrollToShow(pending.current.x, pending.current.width);
    },
    [update, scrollToShow],
  );
  const onContentSizeChange = useCallback(
    (contentWidth: number) => {
      content.current = contentWidth;
      update();
    },
    [update],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offset.current = event.nativeEvent.contentOffset.x;
      update();
    },
    [update],
  );

  return (
    <View style={[styles.frame, bleed ? styles.bleed : null]}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        // A tap on a chip lands even while a field above still holds the keyboard.
        keyboardShouldPersistTaps="handled"
        style={styles.scroller}
        contentContainerStyle={[styles.row, bleed ? styles.bleedRow : null, contentStyle]}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        scrollEventThrottle={32}
        accessibilityRole={accessibilityRole}
        testID={testID}
      >
        <RevealContext.Provider value={scrollToShow}>{children}</RevealContext.Provider>
      </ScrollView>
      {more.start ? (
        <EdgeFade side="start" background={background} testID={`${testID}.fade.start`} />
      ) : null}
      {more.end ? (
        <EdgeFade side="end" background={background} testID={`${testID}.fade.end`} />
      ) : null}
    </View>
  );
}
