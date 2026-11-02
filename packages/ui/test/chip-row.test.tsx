// The sideways chip row: an edge with more to swipe to fades, and a picked option past the edge is
// brought into sight. QA at the largest font saw "Belum ada tek" at the screen edge with two more
// views behind it and nothing saying so.
import { describe, expect, test, vi } from 'vitest';

import { ChipRow } from '../src/components/ChipRow.js';
import { SegmentedControl } from '../src/components/SegmentedControl.js';
import { ToggleChip } from '../src/components/ToggleChip.js';
import { space } from '../src/tokens.js';
import { scrollXCalls } from './doubles/react-native.js';
import { fire, render } from './render.js';

const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 48 } } });
const scrolled = (x: number) => ({ nativeEvent: { contentOffset: { x, y: 0 } } });

function row() {
  return render(
    <ChipRow testID="row">
      <ToggleChip label="Hitam" selected={false} onToggle={vi.fn()} />
      <ToggleChip label="Putih" selected={false} onToggle={vi.fn()} />
    </ChipRow>,
  );
}

describe('ChipRow', () => {
  test('no fade while every chip fits', () => {
    const r = row();
    fire(r.get('row'), 'onLayout', layout(360));
    fire(r.get('row'), 'onContentSizeChange', 300, 48);
    expect(r.query('row.fade.start')).toBeNull();
    expect(r.query('row.fade.end')).toBeNull();
  });

  test('the end fades while more chips lie past it, the start once scrolled', () => {
    const r = row();
    fire(r.get('row'), 'onLayout', layout(360));
    fire(r.get('row'), 'onContentSizeChange', 700, 48);
    expect(r.query('row.fade.start')).toBeNull();
    expect(r.query('row.fade.end')).not.toBeNull();

    fire(r.get('row'), 'onScroll', scrolled(200));
    expect(r.query('row.fade.start')).not.toBeNull();
    expect(r.query('row.fade.end')).not.toBeNull();

    // At the far end nothing is left to swipe to.
    fire(r.get('row'), 'onScroll', scrolled(340));
    expect(r.query('row.fade.start')).not.toBeNull();
    expect(r.query('row.fade.end')).toBeNull();
  });

  test('a fade never takes a tap meant for the chip under it', () => {
    const r = row();
    fire(r.get('row'), 'onLayout', layout(360));
    fire(r.get('row'), 'onContentSizeChange', 700, 48);
    expect(r.get('row.fade.end').props['pointerEvents']).toBe('none');
  });
});

describe('SegmentedControl in a scrolling row', () => {
  const views = (value: string) => (
    <SegmentedControl
      testID="views"
      bleed
      size="compact"
      options={[
        { value: 'active', label: 'Aktif' },
        { value: 'mine', label: 'Tugasku' },
        { value: 'unassigned', label: 'Belum ada teknisi' },
        { value: 'approvals', label: 'Persetujuan (2)' },
      ]}
      value={value}
      onChange={vi.fn()}
    />
  );

  test('opens with a picked view past the edge scrolled into sight, clear of the fade', () => {
    scrollXCalls.length = 0;
    const r = render(views('approvals'));
    // The picked pill lays out before the row knows its width: it waits for it.
    fire(r.get('views.approvals'), 'onLayout', {
      nativeEvent: { layout: { x: 520, y: 0, width: 160, height: 36 } },
    });
    expect(scrollXCalls).toEqual([]);
    fire(r.get('views'), 'onLayout', layout(360));
    expect(scrollXCalls).toEqual([{ x: 520 + 160 + space['2xl'] - 360 }]);
  });

  test('a picked view already in sight stays put', () => {
    scrollXCalls.length = 0;
    const r = render(views('active'));
    fire(r.get('views'), 'onLayout', layout(360));
    fire(r.get('views.active'), 'onLayout', {
      nativeEvent: { layout: { x: 16, y: 0, width: 80, height: 36 } },
    });
    // At x 16 the start fade would cover it only once scrolled; at rest there is none.
    expect(scrollXCalls.every((call) => call.x === 0)).toBe(true);
  });
});

// Regression: in the handover's wrapped checklist a long check ("Bagian yang diperbaiki
// berfungsi") at the largest font ran past the screen's edge. It now wraps inside its chip.
test('a chip in a wrapped list may narrow to the row and wrap its label', () => {
  const r = render(
    <ToggleChip
      testID="c"
      label="Bagian yang diperbaiki berfungsi"
      selected={false}
      onToggle={vi.fn()}
    />,
  );
  expect(r.styleOf('c')).toMatchObject({ flexShrink: 1 });
  const label = r.get('c').queryAll((node) => node.type === 'Text')[0]!;
  expect(label.props['numberOfLines']).toBeUndefined();
});
