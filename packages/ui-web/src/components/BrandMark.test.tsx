import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { BrandMark } from './BrandMark.js';

afterEach(cleanup);

describe('BrandMark', () => {
  test('is named for screen readers unless a visible name sits beside it', () => {
    const { container, rerender } = render(<BrandMark />);
    expect(screen.getByRole('img', { name: 'Bolusi' })).toBeTruthy();
    rerender(<BrandMark label={null} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('keeps its proportions at the asked height', () => {
    const { container, rerender } = render(<BrandMark size={20} />);
    const svg = (): SVGElement => container.querySelector('svg') as SVGElement;
    expect(svg().getAttribute('height')).toBe('20');
    expect(Number(svg().getAttribute('width'))).toBeCloseTo(16.2, 1);
    rerender(<BrandMark size={20} variant="wordmark" tone="dark" />);
    expect(Number(svg().getAttribute('width'))).toBeCloseTo(70.2, 1);
    expect(svg().querySelector('path[fill="#FFF6E5"]')).not.toBeNull();
  });
});
