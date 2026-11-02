import { describe, expect, it } from 'vitest';

import { formatPhone, keepNumbersWhole } from '../src/index.js';

describe('formatPhone', () => {
  it('groups Indonesian mobile numbers in fours', () => {
    expect(formatPhone('081344556677')).toBe('0813-4455-6677');
    expect(formatPhone('08123456789')).toBe('0812-3456-789');
    expect(formatPhone('0812-3456-7890')).toBe('0812-3456-7890');
  });

  it('reads +62 and 62 as a leading 0', () => {
    expect(formatPhone('+62 813 4455 6677')).toBe('0813-4455-6677');
    expect(formatPhone('6281344556677')).toBe('0813-4455-6677');
  });

  it('shows anything else exactly as typed', () => {
    expect(formatPhone('(0951) 321456')).toBe('(0951) 321456');
    expect(formatPhone('0951321456')).toBe('0951321456');
    expect(formatPhone('+61 412 345 678')).toBe('+61 412 345 678');
    expect(formatPhone('0812')).toBe('0812');
    expect(formatPhone('')).toBe('');
  });
});

describe('keepNumbersWhole', () => {
  it('joins the digit groups of a number so it never wraps inside', () => {
    expect(keepNumbersWhole('0812-3456-7890')).toBe('0812\u20113456\u20117890');
    expect(keepNumbersWhole('0813 1111 2222')).toBe('0813\u00A01111\u00A02222');
  });

  it('still lets the words around and between numbers wrap', () => {
    expect(keepNumbersWhole('0812-3456-7890 / 0813 1111 (istri)')).toBe(
      '0812\u20113456\u20117890 / 0813\u00A01111 (istri)',
    );
    expect(keepNumbersWhole('Kantor - 0951')).toBe('Kantor - 0951');
  });
});
