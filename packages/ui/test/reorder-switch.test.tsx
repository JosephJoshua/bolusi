// Reordering by drag and on/off settings: where a dragged row lands, and that both are operable
// without sight or a drag.
import { describe, expect, test, vi } from 'vitest';

import { ListRow } from '../src/components/ListRow.js';
import { ReorderableList, dropIndex } from '../src/components/ReorderableList.js';
import { SwitchRow } from '../src/components/SwitchRow.js';
import { fire, render } from './render.js';

describe('dropIndex', () => {
  const heights = [50, 50, 80, 50];

  test('a row stays put until it passes the middle of its neighbour', () => {
    expect(dropIndex(heights, 1, 0)).toBe(1);
    expect(dropIndex(heights, 1, 40)).toBe(1);
    expect(dropIndex(heights, 1, 41)).toBe(2);
    expect(dropIndex(heights, 1, -26)).toBe(0);
  });

  test('it can pass several rows, and stops at either end', () => {
    expect(dropIndex(heights, 0, 50 + 80 + 26)).toBe(3);
    expect(dropIndex(heights, 0, 10_000)).toBe(3);
    expect(dropIndex(heights, 3, -10_000)).toBe(0);
  });
});

describe('ReorderableList', () => {
  test('each handle is labelled and moves its row with accessibility actions', () => {
    const onMove = vi.fn();
    const r = render(
      <ReorderableList
        testID="list"
        items={['a', 'b', 'c']}
        keyOf={(item) => item}
        renderItem={(item, handle) => <ListRow primaryText={item} trailing={handle} />}
        onMove={onMove}
        handleLabel="Geser untuk mengubah urutan"
        moveUpLabel="Naikkan"
        moveDownLabel="Turunkan"
      />,
    );
    const first = r.get('list.handle.a');
    expect(first.props['accessibilityLabel']).toBe('Geser untuk mengubah urutan');
    expect(first.props['accessibilityActions']).toEqual([{ name: 'moveDown', label: 'Turunkan' }]);
    fire(r.get('list.handle.b'), 'onAccessibilityAction', {
      nativeEvent: { actionName: 'moveUp' },
    });
    expect(onMove).toHaveBeenCalledWith(1, 0);
  });
});

describe('SwitchRow', () => {
  test('the whole row is the switch and announces its state', () => {
    const onValueChange = vi.fn();
    const r = render(
      <SwitchRow testID="sw" label="Tampil di toko ini" value onValueChange={onValueChange} />,
    );
    expect(r.get('sw').props['accessibilityRole']).toBe('switch');
    expect(r.get('sw').props['accessibilityState']).toEqual({ checked: true });
    fire(r.get('sw'), 'onPress');
    expect(onValueChange).toHaveBeenCalledWith(false);
  });
});
