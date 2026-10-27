import { describe, expect, test } from 'vitest';

import { extendPattern, patternCentre, patternDotAt } from '../src/pattern.js';

const CELL = 60;
const at = (dot: number) => patternCentre(dot, CELL);

describe('pattern geometry', () => {
  test('a point near a dot takes it; the gaps between dots take nothing', () => {
    expect(patternDotAt(at(5), CELL)).toBe(5);
    expect(patternDotAt({ x: CELL, y: CELL }, CELL)).toBeNull();
  });

  test('each dot is used once, and passing over a middle dot takes it in', () => {
    let dots = '';
    for (const dot of [1, 3, 3, 9]) dots = extendPattern(dots, at(dot), CELL);
    expect(dots).toBe('12369');
    expect(extendPattern('5', at(5), CELL)).toBe('5');
    // 1 to 9 crosses 5; once 5 is taken, 1 to 9 does not take it again.
    expect(extendPattern('1', at(9), CELL)).toBe('159');
    expect(extendPattern('51', at(9), CELL)).toBe('519');
  });
});
