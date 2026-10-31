// "Batas wewenang" form rules: amounts the server takes, an empty field is not Rp 0, and a change is
// only a change when an amount moved.
import { describe, expect, test } from 'vitest';

import { ROLE_LIMIT_MAX } from '@bolusi/schemas';

import {
  acceptsLimitText,
  LIMIT_CHECK_ABOVE,
  LIMIT_FIELDS,
  limitHintKey,
  limitsText,
  parseLimits,
  sameLimits,
} from './limits.js';

describe('limit amounts', () => {
  test('typed money reads as whole rupiah, and empty stays empty', () => {
    expect(parseLimits({ priceDrop: 'Rp 50.000', refund: '0', credit: '100000' })).toEqual({
      priceDrop: 50_000,
      refund: 0,
      credit: 100_000,
    });
    expect(parseLimits({ priceDrop: '', refund: '0', credit: '0' })).toBeNull();
  });

  test('a keystroke past what the server takes is not kept', () => {
    expect(acceptsLimitText(String(ROLE_LIMIT_MAX))).toBe(true);
    expect(acceptsLimitText(String(ROLE_LIMIT_MAX + 1))).toBe(false);
    expect(acceptsLimitText('')).toBe(true);
  });

  test('the form starts from the saved amounts and compares against them', () => {
    const saved = { priceDrop: 50_000, refund: 0, credit: 100_000 };
    expect(parseLimits(limitsText(saved))).toEqual(saved);
    expect(sameLimits(saved, { ...saved })).toBe(true);
    expect(sameLimits(saved, { ...saved, refund: 1 })).toBe(false);
  });
});

describe('an amount that looks like a typo', () => {
  test('asks to check it, while an ordinary one keeps its explanation', () => {
    const [priceDrop] = LIMIT_FIELDS;
    expect(limitHintKey(priceDrop, 500_000)).toBe(priceDrop.hint);
    expect(limitHintKey(priceDrop, null)).toBe(priceDrop.hint);
    expect(limitHintKey(priceDrop, LIMIT_CHECK_ABOVE)).toBe(priceDrop.hint);
    // Rp 1.000.000 with three zeros too many.
    expect(limitHintKey(priceDrop, 1_000_000_000)).toBe('auth.limits.checkAmount');
  });
});
