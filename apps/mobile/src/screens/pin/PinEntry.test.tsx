// The PIN body on a tablet held sideways: the person and the question on the left, the pad on the
// right, so the whole pad fits a short landscape screen. Upright, and on any phone, it stays stacked.
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { render } from '../../../../../packages/ui/test/render.js';
import { __windowMetrics } from '../../../test/doubles/react-native.js';

import { PinEntry } from './PinEntry.js';

const PHONE = { ...__windowMetrics };
afterEach(() => {
  Object.assign(__windowMetrics, PHONE);
});

function direction(width: number, height: number): unknown {
  Object.assign(__windowMetrics, { width, height });
  const screen = render(
    <PinEntry
      person={{ id: 'u-1', name: 'Maria Wenda', roleKeys: ['staff'] }}
      prompt="Masukkan PIN"
      state="entry"
      onComplete={vi.fn()}
      backspaceLabel="Hapus"
      testID="pin"
    />,
  );
  return StyleSheet.flatten(screen.get('pin').props['style'])['flexDirection'];
}

describe('PinEntry layout', () => {
  test('a tablet in landscape puts the pad beside the person', () => {
    expect(direction(960, 600)).toBe('row');
    expect(direction(1280, 800)).toBe('row');
  });

  test('a phone, and a tablet held upright, keep the pad under the person', () => {
    expect(direction(411, 914)).toBeUndefined();
    expect(direction(800, 1280)).toBeUndefined();
  });
});
