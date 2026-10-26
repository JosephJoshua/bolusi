// Selection and guided-capture components: state is announced and shown with more than colour.
import { StyleSheet } from 'react-native';
import { describe, expect, test, vi } from 'vitest';

import { ListRow } from '../src/components/ListRow.js';
import { PhotoSlot } from '../src/components/PhotoSlot.js';
import { SegmentedControl } from '../src/components/SegmentedControl.js';
import { StepHeader } from '../src/components/StepHeader.js';
import { ToggleChip } from '../src/components/ToggleChip.js';
import { color } from '../src/tokens.js';
import { fire, render, textsIn } from './render.js';

describe('SegmentedControl', () => {
  test('marks only the current option selected and reports a press', () => {
    const onChange = vi.fn();
    const r = render(
      <SegmentedControl
        testID="seg"
        options={[
          { value: 'queue', label: 'Antrian' },
          { value: 'mine', label: 'Saya' },
        ]}
        value="mine"
        onChange={onChange}
      />,
    );
    expect(r.get('seg.queue').props['accessibilityRole']).toBe('radio');
    expect(r.get('seg.queue').props['accessibilityState']).toEqual({
      checked: false,
      selected: false,
    });
    expect(r.get('seg.mine').props['accessibilityState']).toEqual({
      checked: true,
      selected: true,
    });
    fire(r.get('seg.queue'), 'onPress');
    expect(onChange).toHaveBeenCalledWith('queue');
  });

  // Regression: a ScrollView grows by default, so placed straight in a scrolling screen the
  // options stretched to the screen's full height (seen on the price-change step).
  test('the sideways scroller does not grow to fill its parent', () => {
    const r = render(
      <SegmentedControl
        testID="seg"
        options={[{ value: 'a', label: 'A' }]}
        value="a"
        onChange={vi.fn()}
      />,
    );
    expect(StyleSheet.flatten(r.get('seg').props['style'])).toMatchObject({ flexGrow: 0 });
  });

  test('wrap lays the options out on lines instead of scrolling them out of view', () => {
    const r = render(
      <SegmentedControl
        testID="seg"
        wrap
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
        value="a"
        onChange={vi.fn()}
      />,
    );
    expect(StyleSheet.flatten(r.get('seg').props['style'])).toMatchObject({ flexWrap: 'wrap' });
    expect(r.get('seg.b')).toBeDefined();
  });
});

describe('SegmentedControl fill track', () => {
  const track = (value: string) =>
    render(
      <SegmentedControl
        testID="seg"
        fill
        options={[
          { value: 'ok', label: 'Normal', tone: 'success' },
          { value: 'issue', label: 'Rusak', tone: 'danger' },
          { value: 'not_checked', label: 'Tidak dicek' },
        ]}
        value={value}
        onChange={vi.fn()}
      />,
    );

  test('a chosen segment is tinted by its tone; the others are not', () => {
    const r = track('issue');
    expect(StyleSheet.flatten(r.get('seg.issue').props['style'])).toMatchObject({
      backgroundColor: color.dangerBg,
    });
    expect(StyleSheet.flatten(r.get('seg.ok').props['style'])['backgroundColor']).toBeUndefined();
    expect(StyleSheet.flatten(track('ok').get('seg.ok').props['style'])).toMatchObject({
      backgroundColor: color.successBg,
    });
  });

  test('segment labels may wrap but are never cut to one line', () => {
    const [label] = track('ok')
      .get('seg.not_checked')
      .queryAll((n) => n.type === 'Text');
    expect(label?.props['numberOfLines']).toBeUndefined();
  });
});

describe('ListRow as a choice', () => {
  // The enrolment store list showed no chosen state at all (first Android QA run).
  test('the chosen row is a checked radio with a check mark; the others are not', () => {
    const chosen = render(
      <ListRow testID="r" primaryText="Toko Utama" onPress={vi.fn()} selected />,
    );
    expect(chosen.get('r').props['accessibilityRole']).toBe('radio');
    expect(chosen.get('r').props['accessibilityState']).toEqual({ checked: true, selected: true });
    expect(chosen.query('r.check')).not.toBeNull();

    const other = render(
      <ListRow testID="r" primaryText="Toko Kota" onPress={vi.fn()} selected={false} />,
    );
    expect(other.get('r').props['accessibilityState']).toEqual({ checked: false, selected: false });
    expect(other.query('r.check')).toBeNull();
  });

  test('a plain tappable row stays a button', () => {
    const r = render(<ListRow testID="r" primaryText="x" onPress={vi.fn()} />);
    expect(r.get('r').props['accessibilityRole']).toBe('button');
    expect(r.get('r').props['accessibilityState']).toBeUndefined();
  });
});

describe('ToggleChip', () => {
  test('a selected chip is checked and carries a check icon; pressing toggles', () => {
    const onToggle = vi.fn();
    const off = render(
      <ToggleChip testID="c" label="Casing" selected={false} onToggle={onToggle} />,
    );
    expect(off.get('c').props['accessibilityState']).toEqual({ checked: false });
    fire(off.get('c'), 'onPress');
    expect(onToggle).toHaveBeenCalledTimes(1);

    const on = render(<ToggleChip testID="c" label="Casing" selected onToggle={onToggle} />);
    expect(on.get('c').props['accessibilityState']).toEqual({ checked: true });
    expect(on.query('c.check')).not.toBeNull();
    expect(off.query('c.check')).toBeNull();
  });
});

describe('StepHeader', () => {
  test('shows the step count as text, not just the bar', () => {
    const r = render(
      <StepHeader
        testID="s"
        step={2}
        total={6}
        progressLabel="Langkah 2 dari 6"
        title="Perangkat"
      />,
    );
    expect(textsIn(r.get('s.progress'))).toEqual(['Langkah 2 dari 6']);
    expect(textsIn(r.get('s.title'))).toEqual(['Perangkat']);
  });
});

describe('PhotoSlot', () => {
  test('an empty slot is a labelled capture target; a filled one shows done', () => {
    const onPress = vi.fn();
    const empty = render(
      <PhotoSlot
        testID="p"
        label="Depan"
        image={null}
        actionLabel="Ambil foto"
        onPress={onPress}
      />,
    );
    expect(empty.get('p.press').props['accessibilityLabel']).toBe('Depan. Ambil foto');
    expect(empty.query('p.done')).toBeNull();
    fire(empty.get('p.press'), 'onPress');
    expect(onPress).toHaveBeenCalledTimes(1);

    const filled = render(<PhotoSlot testID="p" label="Depan" image={<></>} actionLabel="Ulang" />);
    expect(filled.query('p.done')).not.toBeNull();
    expect(filled.query('p.press')).toBeNull();
  });
});
