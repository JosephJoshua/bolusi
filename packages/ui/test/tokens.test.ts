/**
 * Token gates (design-system §1, §6.1).
 *
 * The contrast test is the reason a reviewer never has to eyeball a hex value: adding a pair that
 * does not clear 4.5:1 fails CI. The WCAG maths is implemented here rather than imported — it is 15
 * lines, and a dependency for it would be exactly the weight §0 rejects.
 */
import { describe, expect, test } from 'vitest';

import {
  border,
  color,
  contrastPairs,
  identityPalette,
  radius,
  size,
  space,
  touch,
  type,
} from '../src/tokens.js';

/** WCAG 2.1 relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 2.1 contrast ratio. */
function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('contrast floor (§6.1)', () => {
  test.each(contrastPairs.map((pair) => [pair.name, pair.fg, pair.bg] as const))(
    '%s clears 4.5:1',
    (_name, fg, bg) => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    },
  );

  test('the contrast helper rejects a pair that fails, so the gate can actually fail', () => {
    // Guards the gate itself: a helper that returned a big number for everything would make every
    // assertion above vacuous.
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio(color.textDisabled, color.surface)).toBeLessThan(4.5);
  });

  test('textDisabled is the sole token exempted from the floor (§6.1)', () => {
    const exempt = contrastPairs.filter((pair) => pair.fg === color.textDisabled);
    expect(exempt).toHaveLength(0);
  });

  test('every identity hue carries white initials (§1.5)', () => {
    for (const hue of identityPalette) {
      expect(contrastRatio(color.onIdentity, hue)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('closed vocabulary (§1)', () => {
  test.each([
    ['color', color],
    ['type', type],
    ['space', space],
    ['radius', radius],
    ['border', border],
    ['touch', touch],
    ['size', size],
  ])('%s is frozen', (_name, token) => {
    expect(Object.isFrozen(token)).toBe(true);
  });

  test('identityPalette is frozen', () => {
    expect(Object.isFrozen(identityPalette)).toBe(true);
  });

  test('identity hues are unique — two people must never collide (§1.5)', () => {
    expect(new Set(identityPalette).size).toBe(identityPalette.length);
  });

  test('no identity hue reuses a semantic colour (§1.5: a person is not an error or a button)', () => {
    const semantic: string[] = [color.primary, color.danger, color.warning, color.success];
    for (const hue of identityPalette) expect(semantic).not.toContain(hue);
  });
});

/**
 * These pin the design-system §1 numbers themselves. Without them, every component test that
 * asserts "height === touch.primary" would be tautological — it would prove the component uses the
 * token, not that the token says what the doc says.
 */
describe('token values match design-system §1 (the anchor for every component assertion)', () => {
  test('touch targets (§1.4)', () => {
    expect(touch.min).toBe(48);
    expect(touch.primary).toBe(56);
    expect(touch.key).toBe(64);
    expect(touch.rowMin).toBe(56);
    expect(touch.row).toBe(64);
    expect(touch.gap).toBe(8);
  });

  test('type scale floors at caption 14 (§1.2)', () => {
    expect(type.body.fontSize).toBe(18);
    expect(type.caption.fontSize).toBe(14);
    const sizes = Object.values(type).map((entry) => entry.fontSize);
    expect(Math.min(...sizes)).toBe(14);
  });

  test('spacing is the 4-dp grid (§1.3)', () => {
    for (const value of Object.values(space)) expect(value % 4).toBe(0);
  });
});
