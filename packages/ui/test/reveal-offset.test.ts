import { describe, expect, it } from 'vitest';

import { revealOffset } from '../src/shell/keyboard.js';
import { space } from '../src/tokens.js';

const M = space.lg;
const view = { visible: 600, offset: 0, mode: 'into-view' as const };

describe('revealOffset', () => {
  it('leaves a box that is already in sight', () => {
    expect(revealOffset({ ...view, y: 100, height: 80 })).toBeNull();
  });

  it('lifts a box below the fold just clear of the bottom', () => {
    expect(revealOffset({ ...view, y: 800, height: 80 })).toBe(800 + 80 + M - 600);
  });

  it('brings a box above the view down to just under the top', () => {
    expect(revealOffset({ ...view, offset: 500, y: 300, height: 80 })).toBe(300 - M);
  });

  it('shows the top of a box taller than the view, where its label and problem are', () => {
    expect(revealOffset({ ...view, y: 800, height: 900 })).toBe(800 - M);
  });
});
