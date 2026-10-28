import { PAPER_PRESETS } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

import { DESK_PAPERS, PHONE_PAPERS, paperFor } from '../src/repair/paper.js';

describe('the paper a device prints on', () => {
  it('is the saved one when this kind of device can print it', () => {
    expect(paperFor(PAPER_PRESETS.a5, PHONE_PAPERS)).toBe('a5');
    expect(paperFor(PAPER_PRESETS.continuous_full, DESK_PAPERS)).toBe('continuous_full');
  });

  it('falls back to the first size before anything is saved or for a size it cannot print', () => {
    expect(paperFor(null, PHONE_PAPERS)).toBe('a4');
    expect(paperFor(null, DESK_PAPERS)).toBe('continuous_half');
    // A phone restored from a PC's settings cannot feed a dot-matrix form.
    expect(paperFor(PAPER_PRESETS.continuous_half, PHONE_PAPERS)).toBe('a4');
    expect(paperFor(PAPER_PRESETS.a4_landscape, DESK_PAPERS)).toBe('continuous_half');
  });
});
