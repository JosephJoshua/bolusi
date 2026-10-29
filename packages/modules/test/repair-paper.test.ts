import { PAPER_PRESETS } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

import {
  DESK_PAPERS,
  PHONE_PAPERS,
  customPaper,
  paperFor,
  paperSettingsFor,
} from '../src/repair/paper.js';

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

describe('a size the store types', () => {
  it('prints at the saved size, on a phone or a PC', () => {
    const typed = customPaper({ widthMm: 216, heightMm: 140, continuous: true })!;
    expect(paperFor(typed, PHONE_PAPERS)).toBe('custom');
    expect(paperSettingsFor(typed, DESK_PAPERS)).toEqual({
      preset: 'custom',
      widthMm: 216,
      heightMm: 140,
      continuous: true,
      carbonless: true,
    });
  });

  it('is refused outside what a printer can take', () => {
    expect(customPaper({ widthMm: 40, heightMm: 140, continuous: false })).toBeNull();
    expect(customPaper({ widthMm: 210, heightMm: 900, continuous: false })).toBeNull();
    expect(customPaper({ widthMm: Number.NaN, heightMm: 140, continuous: false })).toBeNull();
  });
});
