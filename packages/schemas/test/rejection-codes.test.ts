import { describe, expect, test } from 'vitest';

import { REJECTION_CODES, zRejectionCode } from '../src/index.js';

describe('rejection-code enum (05 §8)', () => {
  test('the value set is exactly the eight spec codes — catches silent additions/removals', () => {
    expect([...REJECTION_CODES].sort()).toEqual([
      'BAD_SIGNATURE',
      'CHAIN_BROKEN',
      'CHAIN_GAP',
      'CHAIN_HALTED',
      'DEVICE_REVOKED',
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
