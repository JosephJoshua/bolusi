import { describe, expect, test } from 'vitest';

import { REJECTION_CODES, zRejectionCode } from '../src/index.js';

describe('rejection-code enum (05 §8)', () => {
  test('the value set is exactly the eleven codes — catches silent additions/removals', () => {
    expect([...REJECTION_CODES].sort()).toEqual([
      'BAD_SIGNATURE',
      'CHAIN_BROKEN',
      'CHAIN_GAP',
      'CHAIN_HALTED',
      'CLOCK_AHEAD',
      'DEVICE_REVOKED',
      'PERMISSION_DENIED',
      'RULE_VIOLATED',
      'SCHEMA_INVALID',
      'SCOPE_VIOLATION',
      'UNKNOWN_TYPE',
    ]);
  });

  test('CHAIN_HALTED parses (batch-halt code, 05 §8)', () => {
    expect(zRejectionCode.safeParse('CHAIN_HALTED').success).toBe(true);
  });

  test('a code outside the registry fails', () => {
    expect(zRejectionCode.safeParse('CHAIN_PAUSED').success).toBe(false);
  });
});
