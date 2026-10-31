import { describe, expect, test } from 'vitest';

import { containsUnstorableText, zMoneyIdr, zPayloadNumber } from '../src/index.js';

describe('zMoneyIdr — money is integer IDR, never floats (05 §3)', () => {
  test('accepts an integer amount', () => {
    expect(zMoneyIdr.safeParse(150000).success).toBe(true);
  });

  test('accepts a negative integer (adjustments)', () => {
    expect(zMoneyIdr.safeParse(-25000).success).toBe(true);
  });

  test('rejects 10.5', () => {
    expect(zMoneyIdr.safeParse(10.5).success).toBe(false);
  });

  test('rejects NaN', () => {
    expect(zMoneyIdr.safeParse(Number.NaN).success).toBe(false);
  });

  test('rejects Infinity', () => {
    expect(zMoneyIdr.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  test('rejects a numeric string where a number is required', () => {
    expect(zMoneyIdr.safeParse('150000').success).toBe(false);
  });
});

describe('zPayloadNumber — payload numbers are integers or decimal strings (05 §3)', () => {
  test('accepts an integer', () => {
    expect(zPayloadNumber.safeParse(31).success).toBe(true);
  });

  test('accepts a fractional decimal string', () => {
    expect(zPayloadNumber.safeParse('10.5').success).toBe(true);
  });

  test('accepts an integral decimal string', () => {
    expect(zPayloadNumber.safeParse('-42').success).toBe(true);
  });

  test('rejects a float literal', () => {
    expect(zPayloadNumber.safeParse(3.25).success).toBe(false);
  });

  test('rejects a non-numeric string', () => {
    expect(zPayloadNumber.safeParse('sebelas').success).toBe(false);
  });

  test('rejects exponent notation strings', () => {
    expect(zPayloadNumber.safeParse('1e5').success).toBe(false);
  });

  test('rejects a bare decimal point string', () => {
    expect(zPayloadNumber.safeParse('.5').success).toBe(false);
  });
});

describe('containsUnstorableText — Postgres cannot store U+0000 or a lone surrogate', () => {
  test('finds a NUL in a nested string or an object key', () => {
    expect(containsUnstorableText({ a: [{ b: 'x\u0000y' }] })).toBe(true);
    expect(containsUnstorableText({ ['k\u0000']: 1 })).toBe(true);
    expect(containsUnstorableText('\u0000')).toBe(true);
  });

  test('finds an unpaired surrogate in a nested string or an object key', () => {
    const cutEmoji = '\u{1F4F1}'.slice(0, 1);
    expect(containsUnstorableText({ a: [{ b: `HP ${cutEmoji}` }] })).toBe(true);
    expect(containsUnstorableText('\uDC00x')).toBe(true);
    expect(containsUnstorableText('x\uDBFF')).toBe(true);
    expect(containsUnstorableText('\uDBFF\uDBFF\uDC00')).toBe(true);
    expect(containsUnstorableText({ [`k${cutEmoji}`]: 1 })).toBe(true);
  });

  test('passes ordinary JSON values', () => {
    expect(containsUnstorableText({ a: 'HP rusak \u{1F4F1}\u{1F44D}', b: 'é' })).toBe(false);
    expect(containsUnstorableText({ a: ['x', 1, null, true, { b: 'Rp 50.000' }] })).toBe(false);
    expect(containsUnstorableText('\\u0000')).toBe(false);
  });
});
