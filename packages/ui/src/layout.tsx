/**
 * Layout primitives that let a phone screen use a tablet's room instead of stretching across it.
 *
 * Each one sizes itself to the box it is laid out in, not to the window, so the same screen reads
 * right on a phone, beside the board in a tablet's detail pane, and full screen on a big tablet.
 *
 * - `Columns`: a detail screen's two halves side by side when two phone-width columns fit, stacked
 *   (start first) when they do not. Every column is at least a phone's width, so the content inside
 *   is laid out exactly as it is on a phone.
 * - `ListDetail`: a list beside the record open from it once the screen is wide enough for both.
 * - `TileGrid`: photo and capture tiles that stay thumbnail-sized. On a phone a fixed number share
 *   the row; with more room more tiles fit, so a tile never grows to the size of a phone screen.
 */
import { Children, createContext, useContext, useState, type ReactNode } from 'react';
import { View, type DimensionValue, type LayoutChangeEvent } from 'react-native';

import { border, color, size, space } from './tokens.js';
import { ViewportProvider, useViewport } from './viewport.js';

/**
 * How far content may reach past its column into the screen's gutter on each side: a row's divider
 * running edge to edge, a strip of chips or photos scrolling out from under the gutter. A column
 * beside another reaches out on its outer side only, so nothing runs into the gap between them.
 */
export interface Bleed {
  readonly left: number;
  readonly right: number;
}

const BleedContext = createContext<Bleed>({ left: space.lg, right: space.lg });

export function useBleed(): Bleed {
  return useContext(BleedContext);
}

/** Margins that pull a view out through the gutter; pair with `bleedPadding` inside it. */
export function bleedMargins(bleed: Bleed): { marginLeft: number; marginRight: number } {
  return { marginLeft: -bleed.left, marginRight: -bleed.right };
}

/** The padding that puts a bled view's content back on the column's edge. */
export function bleedPadding(bleed: Bleed): { paddingLeft: number; paddingRight: number } {
  return { paddingLeft: bleed.left, paddingRight: bleed.right };
}

/** The gap between two columns: the same as between two sections, so both read as one page. */
const COLUMN_GAP = space.xl;

/** The narrowest box that takes two columns, each no narrower than a phone's content. */
export const twoColumnsMin = size.columnMin * 2 + COLUMN_GAP;

/**
 * The width a box will have, until it reports its own: the room the screen has, less the shell's
 * gutters, no wider than the column a wide screen allows.
 */
function useBoxWidth(): [number, (event: LayoutChangeEvent) => void] {
  const viewport = useViewport();
  const [measured, setMeasured] = useState<number | null>(null);
  const guess = Math.min(viewport.width, size.wideMax) - space.lg * 2;
  return [
    measured ?? guess,
    (event) => {
      const width = event.nativeEvent.layout.width;
      setMeasured((current) => (current === width ? current : width));
    },
  ];
}

export function Columns({
  start,
  end,
  testID = 'ui.columns',
}: {
  /** What leads on a phone: the record itself and what is done to it next. */
  readonly start: ReactNode;
  /**
   * What follows it on a phone and sits beside it on a tablet: photos, history, reference. Start
   * it with a spaced section (`Section`): stacked, that gap parts it from `start`; side by side,
   * the column takes the gap back so both columns begin on one line. Pass `null` when there is
   * nothing for it today, and `start` keeps the whole width rather than half of an empty page.
   */
  readonly end: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [width, onLayout] = useBoxWidth();
  const outer = useBleed();
  const two = width >= twoColumnsMin && end !== null && end !== undefined && end !== false;
  return (
    <View
      onLayout={onLayout}
      style={two ? { flexDirection: 'row', gap: COLUMN_GAP, alignItems: 'flex-start' } : undefined}
      testID={two ? `${testID}.two` : testID}
    >
      <View style={two ? { flex: 1, minWidth: 0 } : undefined} testID={`${testID}.start`}>
        {/* Always the provider, only its value changes: switching between one column and two
            redraws the content in place instead of remounting it and dropping its state. */}
        <BleedContext.Provider value={two ? { left: outer.left, right: 0 } : outer}>
          {start}
        </BleedContext.Provider>
      </View>
      <View
        style={two ? { flex: 1, minWidth: 0, marginTop: -space.xl } : undefined}
        testID={`${testID}.end`}
      >
        <BleedContext.Provider value={two ? { left: 0, right: outer.right } : outer}>
          {end}
        </BleedContext.Provider>
      </View>
    </View>
  );
}

const TILE_GAP = space.sm;

/**
 * How many tiles share a row of this width: at least `min`, else as many as keep each nearest the
 * target size. Nearest, not "never past it": a big phone's two handover captures stay half the row
 * each, as on any phone, instead of a third tile's gap opening beside them.
 */
export function tileColumns(width: number, min: number): number {
  return Math.max(min, Math.round((width + TILE_GAP) / (size.tileTarget + TILE_GAP)));
}

export function TileGrid({
  min = 3,
  children,
  testID,
}: {
  /** Tiles to a row on a phone: three photos, or two side-by-side captures. */
  readonly min?: number | undefined;
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [measured, setMeasured] = useState<number | null>(null);
  // Until the row is measured, the phone's share of it; a tablet settles on the next frame.
  const share = (n: number): DimensionValue => `${Math.floor(100 / n) - 3}%`;
  const cell: { width: DimensionValue } =
    measured === null
      ? { width: share(min) }
      : (() => {
          const n = tileColumns(measured, min);
          return { width: Math.floor((measured - TILE_GAP * (n - 1)) / n) };
        })();
  return (
    <View
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        setMeasured((current) => (current === width ? current : width));
      }}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP }}
      testID={testID}
    >
      {Children.toArray(children).map((child, index) => (
        // Children.toArray keys each child, so the wrapper reuses that key.
        <View key={(child as { key?: string | null }).key ?? index} style={cell}>
          {child}
        </View>
      ))}
    </View>
  );
}

/**
 * The list's share of a wide screen: wide enough for a row's name, amount and chips (a phone's
 * width), and no wider, so the open record gets the rest.
 */
const LIST_PANE = { share: 0.4, min: 340, max: 420 } as const;

export function listPaneWidth(width: number): number {
  return Math.min(LIST_PANE.max, Math.max(LIST_PANE.min, Math.round(width * LIST_PANE.share)));
}

/** A list and its open record share the screen once there is room for both (`expanded`). */
export function useListDetailSplit(): boolean {
  return useViewport().widthClass === 'expanded';
}

/**
 * A list beside the record open from it on a wide screen, one at a time on a narrow one. The
 * surface keeps one navigation state either way and says what to show: with `split`, both; without
 * it, the one in front (the other `null`). The slots keep their places in both layouts, so turning
 * a tablet redraws the open record instead of remounting it, and a step half filled in survives.
 *
 * `children` are full-screen views that replace both (a task from start to finish, such as an
 * intake); pass `null` for the list and the detail while one shows.
 */
export function ListDetail({
  split,
  list,
  detail,
  children,
  testID,
}: {
  readonly split: boolean;
  readonly list: ReactNode;
  /** The open record, or what to say when none is open yet beside the list. */
  readonly detail: ReactNode;
  readonly children?: ReactNode;
  /** Marks the split layout (`<testID>`, `<testID>.detail`), for tests and QA. */
  readonly testID: string;
}): React.JSX.Element {
  const viewport = useViewport();
  const shown = (node: ReactNode): boolean => node !== null && node !== undefined && node !== false;
  return (
    <View
      style={split ? { flex: 1, flexDirection: 'row' } : { flex: 1 }}
      testID={split ? testID : undefined}
    >
      {shown(list) ? (
        <View
          style={
            split
              ? {
                  width: listPaneWidth(viewport.width),
                  borderRightWidth: border.hairline,
                  borderRightColor: color.border,
                }
              : { flex: 1 }
          }
        >
          {list}
        </View>
      ) : null}
      {shown(detail) ? (
        // The record sizes itself to its pane, not the window: beside the list on a small tablet it
        // has a phone's width, and lays its photos out like one. Until the pane is measured it is
        // taken to be the room the list leaves, so the first frame is not laid out for the window.
        <ViewportProvider
          style={{ flex: 1 }}
          estimate={
            split
              ? { width: viewport.width - listPaneWidth(viewport.width), height: viewport.height }
              : undefined
          }
          testID={split ? `${testID}.detail` : undefined}
        >
          {detail}
        </ViewportProvider>
      ) : null}
      {children}
    </View>
  );
}
