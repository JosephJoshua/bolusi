// Selection and guided-capture components: state is announced and shown with more than colour.
import { StyleSheet } from 'react-native';
import { describe, expect, test, vi } from 'vitest';

import { ChoiceChips } from '../src/components/ChoiceChips.js';
import { ListRow } from '../src/components/ListRow.js';
import { PatternLock } from '../src/components/PatternLock.js';
import { PhotoSlot } from '../src/components/PhotoSlot.js';
import { QuantityStepper } from '../src/components/QuantityStepper.js';
import { SegmentedControl } from '../src/components/SegmentedControl.js';
import { StepHeader } from '../src/components/StepHeader.js';
import { ToggleChip } from '../src/components/ToggleChip.js';
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

describe('SegmentedControl inline', () => {
  // Beside a label each pill keeps its text's width: squeezed, "Tidak dicek" showed as "Tidak".
  test('lays the options in one row whose pills never shrink, and leaves labels uncut', () => {
    const r = render(
      <SegmentedControl
        testID="seg"
        inline
        size="compact"
        options={[{ value: 'not_checked', label: 'Tidak dicek' }]}
        value="not_checked"
        onChange={vi.fn()}
      />,
    );
    expect(StyleSheet.flatten(r.get('seg').props['style'])).toMatchObject({ flexShrink: 0 });
    expect(StyleSheet.flatten(r.get('seg.not_checked').props['style'])).toMatchObject({
      flexShrink: 0,
    });
    const [label] = r.get('seg.not_checked').queryAll((n) => n.type === 'Text');
    // One line that clips, never an ellipsis: the width is guaranteed by the layout above, so this
    // only absorbs Android's draw-time rounding (it wrapped the last word away on device).
    expect(label?.props['numberOfLines']).toBe(1);
    expect(label?.props['ellipsizeMode']).toBe('clip');
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

describe('ListRow as a checkbox', () => {
  test('announces a combinable choice as a checkbox and shows a tick box, filled only when ticked', () => {
    const onPress = vi.fn();
    const r = render(
      <>
        <ListRow testID="on" primaryText="Kasir" checked onPress={onPress} />
        <ListRow testID="off" primaryText="Teknisi" checked={false} onPress={onPress} />
      </>,
    );
    expect(r.get('on').props['accessibilityRole']).toBe('checkbox');
    expect(r.get('on').props['accessibilityState']).toEqual({ checked: true });
    expect(r.get('off').props['accessibilityState']).toEqual({ checked: false });
    // Both rows draw the box (the choice never rides on colour alone); only the ticked one has a tick.
    expect(r.query('on.box')).not.toBeNull();
    expect(r.query('off.box')).not.toBeNull();
    expect(r.get('on.box').children.length).toBe(1);
    expect(r.get('off.box').children.length).toBe(0);
    fire(r.get('off'), 'onPress');
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('PatternLock', () => {
  test('shows a pattern read-only: drawn dots carry their order, and it is read out as steps', () => {
    const r = render(<PatternLock value="1475" accessibilityLabel="Pola" testID="lock" />);
    expect(r.get('lock').props['accessibilityLabel']).toBe('Pola: 1-4-7-5');
    expect(textsIn(r.get('lock.dot.1'))).toEqual(['1']);
    expect(textsIn(r.get('lock.dot.4'))).toEqual(['2']);
    expect(textsIn(r.get('lock.dot.5'))).toEqual(['4']);
    expect(textsIn(r.get('lock.dot.9'))).toEqual([]);
  });
});

describe('QuantityStepper', () => {
  const stepper = (value: number, onChange: (n: number) => void) => (
    <QuantityStepper
      testID="qty"
      label="Jumlah"
      value={value}
      onChange={onChange}
      min={1}
      max={10}
      decreaseLabel="Kurangi"
      increaseLabel="Tambah"
    />
  );

  test('the buttons step within the limits and stop at them', () => {
    const onChange = vi.fn();
    const r = render(stepper(1, onChange));
    expect(r.get('qty.decrease').props['accessibilityState']).toEqual({ disabled: true });
    fire(r.get('qty.increase'), 'onPress');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  // Regression: typing "0" with the value already at the minimum left "0" in the box while the
  // value stayed 1, so a take read 0 and recorded 1.
  test('a typed number out of range shows the nearest allowed one', () => {
    const onChange = vi.fn();
    const r = render(stepper(1, onChange));
    fire(r.get('qty.input'), 'onChangeText', '0');
    expect(r.get('qty.input').props['value']).toBe('1');
    expect(onChange).toHaveBeenLastCalledWith(1);
    fire(r.get('qty.input'), 'onChangeText', '99');
    expect(r.get('qty.input').props['value']).toBe('10');
    expect(onChange).toHaveBeenLastCalledWith(10);
  });
});

describe('ChoiceChips', () => {
  const chips = (
    value: readonly string[],
    onChange: (v: readonly string[]) => void,
    multiple = false,
  ) => (
    <ChoiceChips
      testID="cc"
      label="Kualitas"
      options={['Original', 'OEM', 'KW']}
      value={value}
      onChange={onChange}
      multiple={multiple}
      addLabel="Lainnya"
    />
  );

  test('one value: a tap picks it in place of the last, a second tap clears it', () => {
    const onChange = vi.fn();
    const r = render(chips(['OEM'], onChange));
    fire(r.get('cc.option.kw'), 'onPress');
    expect(onChange).toHaveBeenLastCalledWith(['KW']);
    fire(r.get('cc.option.oem'), 'onPress');
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test('several values add up, and the picked ones lead the row', () => {
    const onChange = vi.fn();
    const r = render(chips(['KW'], onChange, true));
    expect(textsIn(r.get('cc.chips'))).toStrictEqual(['KW', 'Original', 'OEM', 'Lainnya']);
    fire(r.get('cc.option.original'), 'onPress');
    expect(onChange).toHaveBeenLastCalledWith(['KW', 'Original']);
  });

  test('a typed value is added once, matching a listed one whatever its case', () => {
    const onChange = vi.fn();
    const r = render(chips([], onChange, true));
    fire(r.get('cc.add'), 'onPress');
    fire(r.get('cc.field.field'), 'onChangeText', 'oem');
    fire(r.get('cc.field.field'), 'onSubmitEditing');
    expect(onChange).toHaveBeenLastCalledWith(['OEM']);
    fire(r.get('cc.field.field'), 'onChangeText', 'Copotan');
    fire(r.get('cc.field.field'), 'onSubmitEditing');
    expect(onChange).toHaveBeenLastCalledWith(['Copotan']);
  });
});
