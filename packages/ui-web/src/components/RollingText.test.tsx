import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { RollingText } from './RollingText.js';

describe('RollingText', () => {
  test('rolls up on a rise and down on a drop, never on first show', () => {
    const r = render(
      <RollingText value={100} testId="fig">
        Rp 100
      </RollingText>,
    );
    const fig = () => r.getByTestId('fig');
    expect(fig().className).not.toMatch(/animate-roll/);
    r.rerender(
      <RollingText value={150} testId="fig">
        Rp 150
      </RollingText>,
    );
    expect(fig().className).toMatch(/animate-roll-up/);
    r.rerender(
      <RollingText value={20} testId="fig">
        Rp 20
      </RollingText>,
    );
    expect(fig().className).toMatch(/animate-roll-down/);
    expect(fig().textContent).toBe('Rp 20');
  });
});
