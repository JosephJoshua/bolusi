// The log-hygiene contract for parse-failure descriptions (03 §12).
//
// WHY THESE ASSERTIONS ARE PHRASED AS EXCLUSIONS. The helper exists so a rejected value never
// reaches a log file: Zod's `message`/`keys` can quote caller-supplied text, so the description is
// REBUILT from `path` (schema structure) and `code` (fixed enum) only. The load-bearing cases here
// are the negative ones — the quoted secret must NOT appear — because a wording tweak that starts
// passing raw messages through would keep every positive case green.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeParseFailure } from '../../src/errors/describe-parse-failure.js';

describe('describeParseFailure', () => {
  it('describes a ZodError by path and code only', () => {
    const schema = z.object({ pin: z.string().max(4) });
    const result = schema.safeParse({ pin: 'hunter2-secret' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const described = describeParseFailure(result.error);
    expect(described).toBe('pin: too_big');
  });

  it('never quotes the rejected value, even via message text', () => {
    const schema = z.object({ pin: z.string().regex(/^\d{4}$/) });
    const result = schema.safeParse({ pin: 'hunter2-secret' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const described = describeParseFailure(result.error);
    expect(described).not.toContain('hunter2-secret');
  });

  it('never quotes unrecognized key names from strict-object failures', () => {
    const schema = z.strictObject({ ok: z.string() });
    const result = schema.safeParse({ ok: 'x', stolenCardNumber: '4111' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const described = describeParseFailure(result.error);
    expect(described).not.toContain('stolenCardNumber');
    expect(described).not.toContain('4111');
  });

  it('labels a root-level issue as (root)', () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(describeParseFailure(result.error)).toBe('(root): invalid_type');
  });

  it('joins multiple issues with semicolons', () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(describeParseFailure(result.error)).toBe('a: invalid_type; b: invalid_type');
  });

  it('falls back to the error name for non-Zod errors (never the message)', () => {
    const err = new RangeError('secret-value-was-7');
    expect(describeParseFailure(err)).toBe('RangeError');
  });

  it('falls back to a fixed string for non-error causes', () => {
    expect(describeParseFailure('raw string cause')).toBe('parse failed');
    expect(describeParseFailure(undefined)).toBe('parse failed');
  });
});
