/**
 * Moving text redraws at a new system font size like any other text. The real crash this guards
 * (Android: "Animated node is already attached to a view") only shows on a device; here the check
 * is that the animated text itself is mounted afresh, so its animation binds to the new view.
 */
import { act } from 'react';
import { afterEach, expect, test } from 'vitest';

import { RollingText } from '../src/components/RollingText.js';
import { AnimatedText, FontScaleProvider } from '../src/text.js';
import { __windowMetrics } from './doubles/react-native.js';
import { render } from './render.js';

afterEach(() => {
  __windowMetrics.fontScale = 1;
});

test('AnimatedText mounts a fresh view when the font scale changes', () => {
  const views = new Set<unknown>();
  const ref = (view: unknown): void => {
    if (view !== null) views.add(view);
  };
  const tree = (): React.JSX.Element => (
    <FontScaleProvider>
      <AnimatedText ref={ref}>Rp 100.000</AnimatedText>
    </FontScaleProvider>
  );
  const { rerender } = render(tree());
  rerender(tree());
  expect(views.size).toBe(1);

  act(() => {
    __windowMetrics.fontScale = 1.3;
  });
  rerender(tree());
  expect(views.size).toBe(2);
});

test('a figure that has rolled keeps its value across a font scale change', () => {
  const tree = (value: number): React.JSX.Element => (
    <FontScaleProvider>
      <RollingText value={value} testID="fig">
        {`Rp ${value}`}
      </RollingText>
    </FontScaleProvider>
  );
  const { rerender, get } = render(tree(100));
  rerender(tree(50));
  __windowMetrics.fontScale = 1.3;
  rerender(tree(50));
  expect(get('fig').children).toEqual(['Rp 50']);
});
