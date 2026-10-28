import { describe, expect, it } from 'vitest';

import { formatPhone } from '../src/index.js';

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
