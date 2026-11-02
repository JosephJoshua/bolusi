// The tablet layout primitives size themselves to their own box, so a screen reads right on a phone,
// beside a list in a tablet's pane, and full screen on a big tablet.
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { afterEach, describe, expect, test } from 'vitest';

import { ChipRow } from '../src/components/ChipRow.js';
import {
  Columns,
  ListDetail,
  TileGrid,
  listPaneWidth,
  tileColumns,
  twoColumnsMin,
} from '../src/layout.js';
import { size, space } from '../src/tokens.js';
import { __windowMetrics } from './doubles/react-native.js';
import { fire, render, type RenderResult } from './render.js';

const phone = { ...__windowMetrics };
afterEach(() => {
  Object.assign(__windowMetrics, phone);
});

function layOut(screen: RenderResult, testID: string, width: number): void {
  fire(screen.get(testID), 'onLayout', { nativeEvent: { layout: { width, height: 800 } } });
}

describe('Columns', () => {
  const columns = (end: React.ReactNode = <Text testID="end">e</Text>) =>
    render(<Columns start={<Text testID="start">s</Text>} end={end} />);

  test('on a phone the halves stack, the record first', () => {
    Object.assign(__windowMetrics, { width: 360, height: 740 });
    const screen = columns();
    expect(screen.query('ui.columns')).not.toBeNull();
    expect(screen.query('ui.columns.two')).toBeNull();
    // Stacked, the end keeps its own section gap above it.
    expect(screen.styleOf('ui.columns.end')['marginTop']).toBeUndefined();
  });

  test('side by side once two phone-width columns fit, both starting on one line', () => {
    Object.assign(__windowMetrics, { width: 800, height: 1280 });
    const screen = columns();
    expect(screen.query('ui.columns.two')).not.toBeNull();
    expect(screen.styleOf('ui.columns.two')['flexDirection']).toBe('row');
    expect(screen.styleOf('ui.columns.end')['marginTop']).toBe(-space.xl);
  });

  test('follows its own box, not the window: a narrow pane on a wide tablet stacks', () => {
    Object.assign(__windowMetrics, { width: 1280, height: 800 });
    const screen = columns();
    expect(screen.query('ui.columns.two')).not.toBeNull();
    layOut(screen, 'ui.columns.two', twoColumnsMin - 1);
    expect(screen.query('ui.columns.two')).toBeNull();
    layOut(screen, 'ui.columns', twoColumnsMin);
    expect(screen.query('ui.columns.two')).not.toBeNull();
  });

  test('switching between one column and two keeps what is inside, not remounting it', () => {
    Object.assign(__windowMetrics, { width: 1280, height: 800 });
    let mounts = 0;
    function Counted(): React.JSX.Element {
      useState(() => (mounts += 1));
      return <Text testID="counted">c</Text>;
    }
    const screen = render(<Columns start={<Counted />} end={<Counted />} />);
    expect(mounts).toBe(2);
    layOut(screen, 'ui.columns.two', 360);
    expect(screen.query('ui.columns.two')).toBeNull();
    layOut(screen, 'ui.columns', 900);
    expect(screen.query('ui.columns.two')).not.toBeNull();
    expect(mounts).toBe(2);
  });

  test('with nothing for the end today, the start keeps the whole width', () => {
    Object.assign(__windowMetrics, { width: 1280, height: 800 });
    const screen = columns(null);
    expect(screen.query('ui.columns.two')).toBeNull();
  });

  test('a strip in a column beside another bleeds only through the outer gutter', () => {
    Object.assign(__windowMetrics, { width: 1280, height: 800 });
    const screen = render(
      <Columns
        start={<ChipRow testID="startRow">{null}</ChipRow>}
        end={<ChipRow testID="endRow">{null}</ChipRow>}
      />,
    );
    // The row's chips start on the column's edge: padded back by as much as the row bleeds.
    const padding = (id: string) =>
      StyleSheet.flatten(screen.get(id).props['contentContainerStyle'] as never);
    expect(padding('startRow')).toMatchObject({ paddingLeft: space.lg, paddingRight: 0 });
    expect(padding('endRow')).toMatchObject({ paddingLeft: 0, paddingRight: space.lg });
    layOut(screen, 'ui.columns.two', 360);
    // Stacked, both reach through both gutters as on a phone.
    expect(padding('startRow')).toMatchObject({ paddingLeft: space.lg, paddingRight: space.lg });
  });
});

describe('TileGrid', () => {
  test('three photos to a phone row, more as the row grows, each near the tile size', () => {
    expect(tileColumns(328, 3)).toBe(3);
    expect(tileColumns(328, 2)).toBe(2);
    // A big phone (411 dp) keeps its two handover captures half the row each, as main had.
    expect(tileColumns(379, 2)).toBe(2);
    expect(tileColumns(379, 3)).toBe(3);
    expect(tileColumns(688, 3)).toBe(4);
    expect(tileColumns(1008, 2)).toBe(6);
    for (const width of [340, 379, 500, 688, 1008]) {
      const n = tileColumns(width, 2);
      const tile = (width - space.sm * (n - 1)) / n;
      expect(tile).toBeGreaterThanOrEqual(size.tileTarget * 0.75);
      expect(tile).toBeLessThanOrEqual(size.tileTarget * 1.3);
    }
  });

  test('each tile takes its share of the measured row', () => {
    const screen = render(
      <TileGrid min={2} testID="grid">
        <Text testID="a">a</Text>
        <Text testID="b">b</Text>
      </TileGrid>,
    );
    layOut(screen, 'grid', 688);
    const cell = screen.get('a').parent!;
    const width = StyleSheet.flatten(cell.props['style'] as never)['width'] as number;
    expect(width).toBe(Math.floor((688 - space.sm * 3) / 4));
  });
});

describe('ListDetail', () => {
  test('gives the list a phone width and the record the rest', () => {
    expect(listPaneWidth(840)).toBe(340);
    expect(listPaneWidth(960)).toBe(384);
    expect(listPaneWidth(1280)).toBe(420);
  });

  test('beside the list, a record is laid out for its pane from the first frame', () => {
    // A small tablet sideways: the pane is 576 wide, too narrow for two columns, though the
    // window alone would take them.
    Object.assign(__windowMetrics, { width: 960, height: 600 });
    const screen = render(
      <ListDetail
        split
        list={<Text>l</Text>}
        detail={<Columns start={<Text>s</Text>} end={<Text>e</Text>} />}
        testID="x.split"
      />,
    );
    expect(screen.query('ui.columns')).not.toBeNull();
    expect(screen.query('ui.columns.two')).toBeNull();
  });

  test('split shows both; otherwise only the one in front', () => {
    const both = render(
      <ListDetail
        split
        list={<Text testID="list">l</Text>}
        detail={<Text testID="detail">d</Text>}
        testID="x.split"
      />,
    );
    expect(both.query('x.split')).not.toBeNull();
    expect(both.query('x.split.detail')).not.toBeNull();
    expect(both.query('list')).not.toBeNull();
    expect(both.query('detail')).not.toBeNull();

    const one = render(
      <ListDetail
        split={false}
        list={null}
        detail={<Text testID="detail">d</Text>}
        testID="x.split"
      />,
    );
    expect(one.query('x.split')).toBeNull();
    expect(one.query('detail')).not.toBeNull();
  });
});
