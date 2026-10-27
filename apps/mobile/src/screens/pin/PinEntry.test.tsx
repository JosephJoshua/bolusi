// The PIN body on a tablet held sideways: the person and the question on the left, the pad on the
// right, so the whole pad fits a short landscape screen. Upright, and on any phone, it stays stacked.
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { fire, render } from '../../../../../packages/ui/test/render.js';
import { __windowMetrics } from '../../../test/doubles/react-native.js';

import { PinEntry } from './PinEntry.js';

const PHONE = { ...__windowMetrics };
afterEach(() => {
  Object.assign(__windowMetrics, PHONE);
});

const entry = (): React.JSX.Element => (
  <PinEntry
    person={{ id: 'u-1', name: 'Maria Wenda', roleKeys: ['staff'] }}
    prompt="Masukkan PIN"
    state="entry"
    onComplete={vi.fn()}
    backspaceLabel="Hapus"
    testID="pin"
  />
);

function direction(width: number, height: number): unknown {
  Object.assign(__windowMetrics, { width, height });
  const screen = render(entry());
  return StyleSheet.flatten(screen.get('pin').props['style'])['flexDirection'];
}

describe('PinEntry layout', () => {
  test('a tablet in landscape puts the pad beside the person', () => {
    expect(direction(960, 600)).toBe('row');
    expect(direction(1280, 800)).toBe('row');
  });

  test('turning the tablet mid-entry keeps the digits typed', () => {
    Object.assign(__windowMetrics, { width: 800, height: 1280 });
    const screen = render(entry());
    for (const digit of '482') fire(screen.get('pin-pad.key.' + digit), 'onPress');
    Object.assign(__windowMetrics, { width: 1280, height: 800 });
    screen.rerender(entry());
    expect(StyleSheet.flatten(screen.get('pin').props['style'])['flexDirection']).toBe('row');
    expect(screen.get('pin-pad.entry').props['accessibilityValue']).toMatchObject({ now: 3 });
  });

  test('a phone, and a tablet held upright, keep the pad under the person', () => {
    expect(direction(411, 914)).toBeUndefined();
    expect(direction(800, 1280)).toBeUndefined();
  });
});
